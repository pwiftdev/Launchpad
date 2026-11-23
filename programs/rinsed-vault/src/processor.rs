use crate::{state::*, validation::*};
use solana_program::{account_info::AccountInfo, bpf_loader_upgradeable::{self,UpgradeableLoaderState}, clock::Clock,
    entrypoint::ProgramResult, hash::{hash,hashv}, instruction::{AccountMeta,Instruction},
    program::{invoke,invoke_signed}, program_error::ProgramError, pubkey::Pubkey,
    rent::Rent, system_instruction, system_program, sysvar::Sysvar};
use spl_token::{instruction as token_ix, state::Account as TokenAccount};
use solana_program::program_pack::Pack;
use uint::construct_uint;
construct_uint! { pub struct U256(4); }

pub const INITIALIZE:[u8;8]=[175,175,109,31,13,152,155,237];
pub const APPROVE:[u8;8]=[146,144,8,61,28,151,38,223];
pub const REGISTER:[u8;8]=[79,37,188,46,209,104,90,10];
pub const COLLECT:[u8;8]=[164,152,207,99,30,186,19,182];
pub const COLLECT_DAMM:[u8;8]=[37,53,27,55,216,32,146,36];
pub const BUYBACK:[u8;8]=[93,133,32,3,36,116,94,202];
pub const CREATE_EPOCH:[u8;8]=[115,111,36,230,59,145,168,27];
pub const CLAIM_COMMUNITY:[u8;8]=[173,149,181,224,83,48,122,68];
pub const CLAIM_CREATOR:[u8;8]=[231,240,197,249,244,10,21,59];
pub const CLAIM_PLATFORM:[u8;8]=[87,87,70,211,100,203,95,163];
pub const PAUSE:[u8;8]=[91,60,125,192,176,225,166,218];
pub const BIND:[u8;8]=[34,183,164,93,193,115,133,237];

struct Reader<'a>{data:&'a[u8],at:usize}
impl<'a> Reader<'a>{
    fn new(data:&'a[u8])->Self{Self{data,at:0}}
    fn bytes<const N:usize>(&mut self)->Result<[u8;N],ProgramError>{
        let end=self.at.checked_add(N).ok_or(ProgramError::InvalidInstructionData)?;
        let result=self.data.get(self.at..end).ok_or(ProgramError::InvalidInstructionData)?.try_into().map_err(|_|ProgramError::InvalidInstructionData)?;
        self.at=end;Ok(result)
    }
    fn u8(&mut self)->Result<u8,ProgramError>{Ok(self.bytes::<1>()?[0])}
    fn u16(&mut self)->Result<u16,ProgramError>{Ok(u16::from_le_bytes(self.bytes()?))}
    fn u64(&mut self)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(self.bytes()?))}
    fn i64(&mut self)->Result<i64,ProgramError>{Ok(i64::from_le_bytes(self.bytes()?))}
    fn end(&self)->ProgramResult{require(self.at==self.data.len())}
}
fn signer(account:&AccountInfo)->ProgramResult {if account.is_signer{Ok(())}else{Err(ProgramError::MissingRequiredSignature)}}
fn key_is(account:&AccountInfo,key:&Pubkey)->ProgramResult{require(account.key==key)}
fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(ProgramError::ArithmeticOverflow)}
fn sub(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_sub(b).ok_or(ProgramError::InsufficientFunds)}
fn settings(account:&AccountInfo,program:&Pubkey)->Result<Settings,ProgramError>{
    key_is(account,&Pubkey::find_program_address(&[b"settings"],program).0)?;
    let s=load::<Settings>(account,program)?;require(s.version==1 && s.paused<=1)?;Ok(s)
}
fn coin(account:&AccountInfo,program:&Pubkey)->Result<Coin,ProgramError>{
    let c=load::<Coin>(account,program)?;
    key_is(account,&Pubkey::create_program_address(&[b"coin",&c.mint,&[c.bump]],program).map_err(|_|ProgramError::InvalidSeeds)?)?;
    require(c.version==1 && c.mode<=1)?;solvent(account,&c)?;Ok(c)
}
fn solvent(account:&AccountInfo,coin:&Coin)->ProgramResult{
    require(account.lamports()>=add(Rent::get()?.minimum_balance(Coin::SPACE),coin.liabilities()?)?)
}
fn move_sol(from:&AccountInfo,to:&AccountInfo,amount:u64)->ProgramResult{
    require(from.key!=to.key && from.is_writable && to.is_writable)?;
    let left=sub(from.lamports(),amount)?;let right=add(to.lamports(),amount)?;
    **from.try_borrow_mut_lamports()?=left;**to.try_borrow_mut_lamports()?=right;Ok(())
}
fn create<'a>(payer:&AccountInfo<'a>,new:&AccountInfo<'a>,system:&AccountInfo<'a>,program:&Pubkey,seeds:&[&[u8]],space:usize)->Result<u8,ProgramError>{
    signer(payer)?;key_is(system,&system_program::id())?;
    let (expected,bump)=Pubkey::find_program_address(seeds,program);key_is(new,&expected)?;
    require(new.owner==&system_program::id() && new.data_is_empty())?;
    let rent=Rent::get()?.minimum_balance(space);
    // A third-party donation to an uninitialized PDA cannot prevent initialization.
    let missing=rent.saturating_sub(new.lamports());
    if missing>0{invoke(&system_instruction::transfer(payer.key,new.key,missing),&[payer.clone(),new.clone(),system.clone()])?;}
    let bump_seed=[bump];let mut signed=seeds.to_vec();signed.push(&bump_seed);
    invoke_signed(&system_instruction::allocate(new.key,space as u64),&[new.clone(),system.clone()],&[&signed])?;
    invoke_signed(&system_instruction::assign(new.key,program),&[new.clone(),system.clone()],&[&signed])?;Ok(bump)
}
fn work(s:&Settings,operator:&AccountInfo)->ProgramResult {signer(operator)?;require(s.paused==0 && operator.key.to_bytes()==s.operator)}
fn governor(s:&Settings,account:&AccountInfo)->ProgramResult{signer(account)?;require(account.key.to_bytes()==s.governor)}
fn event_authority(program:&Pubkey)->Pubkey{Pubkey::find_program_address(&[b"__event_authority"],program).0}
fn close_quote<'a>(quote:&AccountInfo<'a>,coin:&AccountInfo<'a>,token_program:&AccountInfo<'a>,state:&Coin)->ProgramResult{
    let ix=token_ix::close_account(&spl_token::id(),quote.key,coin.key,coin.key,&[])?;
    invoke_signed(&ix,&[quote.clone(),coin.clone(),token_program.clone()],&[&[b"coin",&state.mint,&[state.bump]]])
}

pub fn process(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
    require(data.len()>=8 && data.len()<=2048)?;
    let disc:[u8;8]=data[..8].try_into().map_err(|_|ProgramError::InvalidInstructionData)?;
    if disc==hash(b"global:allocate_collected_fees").to_bytes()[..8] {return allocate_collected(program,accounts,&data[8..]);}
    match disc{
        INITIALIZE=>initialize(program,accounts,&data[8..]), APPROVE=>approve(program,accounts,&data[8..]),
        REGISTER=>register(program,accounts,&data[8..]), PAUSE=>pause(program,accounts,&data[8..]),
        COLLECT=>collect(program,accounts,&data[8..],false),COLLECT_DAMM=>collect(program,accounts,&data[8..],true),
        BUYBACK=>buyback(program,accounts,&data[8..]), CREATE_EPOCH=>create_epoch(program,accounts,&data[8..]),
        CLAIM_COMMUNITY=>claim_community(program,accounts,&data[8..]),
        CLAIM_CREATOR=>claim_creator(program,accounts,&data[8..]),CLAIM_PLATFORM=>claim_platform(program,accounts,&data[8..]),
        BIND=>bind(program,accounts,&data[8..]),_=>Err(ProgramError::InvalidInstructionData)
    }
}

fn initialize(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==5)?;let mut r=Reader::new(data);let operator=r.bytes()?;let treasury=r.bytes()?;let paused=r.u8()?;r.end()?;
    signer(&a[0])?;key_is(&a[2],program)?;
    require(a[2].executable && a[2].owner==&bpf_loader_upgradeable::id() && a[3].owner==&bpf_loader_upgradeable::id())?;
    let program_state:UpgradeableLoaderState=bincode::deserialize(&a[2].try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;
    let address=Pubkey::find_program_address(&[program.as_ref()],&bpf_loader_upgradeable::id()).0;
    key_is(&a[3],&address)?;
    match program_state{UpgradeableLoaderState::Program{programdata_address}=>require(programdata_address==address)?,_=>return Err(ProgramError::InvalidAccountData)}
    let programdata:UpgradeableLoaderState=bincode::deserialize(&a[3].try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;
    match programdata{UpgradeableLoaderState::ProgramData{upgrade_authority_address:Some(authority),..}=>key_is(&a[0],&authority)?,_=>return Err(ProgramError::IncorrectAuthority)}
    require(paused<=1 && operator!=[0;32] && treasury!=[0;32] && operator!=fee_authority(program).0.to_bytes())?;
    let bump=create(&a[0],&a[1],&a[4],program,&[b"settings"],Settings::SPACE)?;
    save(&a[1],&Settings{version:1,bump,paused,governor:a[0].key.to_bytes(),operator,treasury})
}
fn approve(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==5 && data.is_empty())?;let s=settings(&a[1],program)?;governor(&s,&a[0])?;require(s.paused==0)?;
    let digest=config(&a[3],&fee_authority(program).0)?;
    let bump=create(&a[0],&a[2],&a[4],program,&[b"config",a[3].key.as_ref()],ConfigApproval::SPACE)?;
    save(&a[2],&ConfigApproval{version:1,bump,config:a[3].key.to_bytes(),digest})
}
fn register(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==8 && data.len()==1 && data[0]<=1)?;signer(&a[0])?;let s=settings(&a[1],program)?;require(s.paused==0)?;
    mint(&a[3])?;account(&a[4],&DBC,&POOL_DISC,424)?;
    let digest=config(&a[5],&fee_authority(program).0)?;
    let approval=load::<ConfigApproval>(&a[6],program)?;
    key_is(&a[6],&Pubkey::find_program_address(&[b"config",a[5].key.as_ref()],program).0)?;
    require(approval.version==1 && approval.config==a[5].key.to_bytes() && approval.digest==digest)?;
    let activation;
    {let p=a[4].try_borrow_data()?;
    require(key(&p,72)?==*a[5].key && key(&p,104)?==*a[0].key && key(&p,136)?==*a[3].key && p[305]==0)?;
    activation=i64::try_from(u64_at(&p,296)?).map_err(|_|ProgramError::InvalidAccountData)?;}
    require(activation>=0 && activation<=Clock::get()?.unix_timestamp)?;
    let bump=create(&a[0],&a[2],&a[7],program,&[b"coin",a[3].key.as_ref()],Coin::SPACE)?;
    save(&a[2],&Coin{version:1,bump,mode:data[0],mint:a[3].key.to_bytes(),pool:a[4].key.to_bytes(),config:a[5].key.to_bytes(),
        creator:a[0].key.to_bytes(),activation,buyback:0,creator_budget:0,community:0,platform:0,nonce:0,burned:0,
        migrated_pool:[0;32],position:[0;32],nft_account:[0;32],config_hash:digest,rinse_net:0,post_net:0,unallocated_collected:0})
}
fn pause(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==2 && data.len()==1 && data[0]<=1)?;let mut s=settings(&a[1],program)?;governor(&s,&a[0])?;
    s.paused=data[0];save(&a[1],&s)
}
fn claim_creator(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==2)?;let mut r=Reader::new(data);let amount=r.u64()?;r.end()?;signer(&a[0])?;
    let mut c=coin(&a[1],program)?;require(amount>0 && c.mode==0 && c.creator==a[0].key.to_bytes())?;
    c.creator_budget=sub(c.creator_budget,amount)?;move_sol(&a[1],&a[0],amount)?;save(&a[1],&c)?;solvent(&a[1],&c)
}
fn claim_platform(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==3)?;let mut r=Reader::new(data);let amount=r.u64()?;r.end()?;signer(&a[0])?;
    let s=settings(&a[2],program)?;require(amount>0 && s.treasury==a[0].key.to_bytes())?;let mut c=coin(&a[1],program)?;
    c.platform=sub(c.platform,amount)?;move_sol(&a[1],&a[0],amount)?;save(&a[1],&c)?;solvent(&a[1],&c)
}
fn create_epoch(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==5)?;let mut r=Reader::new(data);let epoch=r.u64()?;let root=r.bytes()?;let snapshot_slot=r.u64()?;
    let snapshot_digest=r.bytes()?;let total=r.u64()?;r.end()?;
    let s=settings(&a[1],program)?;work(&s,&a[0])?;let mut c=coin(&a[2],program)?;let now=Clock::get()?;
    require(c.mode==1 && total>0 && root!=[0;32] && snapshot_digest!=[0;32] && snapshot_slot>0 && snapshot_slot<=now.slot
        && now.unix_timestamp>=c.activation+27 && epoch<(now.unix_timestamp.max(0) as u64)/3600)?;
    c.community=sub(c.community,total)?;let epoch_bytes=epoch.to_le_bytes();
    let bump=create(&a[0],&a[3],&a[4],program,&[b"epoch",a[2].key.as_ref(),&epoch_bytes],Epoch::SPACE)?;
    move_sol(&a[2],&a[3],total)?;
    save(&a[3],&Epoch{version:1,bump,coin:a[2].key.to_bytes(),epoch,root,snapshot_slot,snapshot_digest,total,remaining:total})?;
    save(&a[2],&c)?;solvent(&a[2],&c)
}
pub fn merkle_leaf(program:&Pubkey,coin:&Pubkey,epoch:u64,wallet:&Pubkey,amount:u64)->[u8;32]{
    hashv(&[b"rinse-claim-v1",program.as_ref(),coin.as_ref(),&epoch.to_le_bytes(),wallet.as_ref(),&amount.to_le_bytes()]).to_bytes()
}
fn claim_community(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==5)?;let mut r=Reader::new(data);let epoch=r.u64()?;let amount=r.u64()?;let count=r.u16()?;
    require(amount>0 && count<=32)?;signer(&a[0])?;let c=coin(&a[1],program)?;require(c.mode==1)?;
    let mut e=load::<Epoch>(&a[2],program)?;let epoch_bytes=epoch.to_le_bytes();
    key_is(&a[2],&Pubkey::find_program_address(&[b"epoch",a[1].key.as_ref(),&epoch_bytes],program).0)?;
    require(e.version==1 && e.coin==a[1].key.to_bytes() && e.epoch==epoch && e.remaining<=e.total)?;
    let mut node=merkle_leaf(program,a[1].key,epoch,a[0].key,amount);
    for _ in 0..count{let sibling:[u8;32]=r.bytes()?;node=if node<=sibling{hashv(&[&node,&sibling]).to_bytes()}else{hashv(&[&sibling,&node]).to_bytes()};}
    r.end()?;require(node==e.root)?;e.remaining=sub(e.remaining,amount)?;
    require(a[2].lamports()>=add(Rent::get()?.minimum_balance(Epoch::SPACE),add(e.remaining,amount)?)?)?;
    let bump=create(&a[0],&a[3],&a[4],program,&[b"claim",a[2].key.as_ref(),a[0].key.as_ref()],Claim::SPACE)?;
    move_sol(&a[2],&a[0],amount)?;
    save(&a[3],&Claim{version:1,bump,epoch:a[2].key.to_bytes(),wallet:a[0].key.to_bytes(),amount})?;save(&a[2],&e)
}

// DEX custody and buyback handlers follow below; only these handlers can spend a funded budget.

fn dbc_pool(c:&Coin,pool:&AccountInfo,cfg:&AccountInfo,program:&Pubkey)->ProgramResult{
    key_is(pool,&Pubkey::new_from_array(c.pool))?;key_is(cfg,&Pubkey::new_from_array(c.config))?;
    account(pool,&DBC,&POOL_DISC,424)?;
    require(config(cfg,&fee_authority(program).0)?==c.config_hash)?;
    let data=pool.try_borrow_data()?;
    require(key(&data,72)?.to_bytes()==c.config && key(&data,136)?.to_bytes()==c.mint
        && i64::try_from(u64_at(&data,296)?).ok()==Some(c.activation))
}
fn damm_pool(c:&Coin,pool:&AccountInfo)->ProgramResult{
    require(c.migrated_pool!=[0;32])?;key_is(pool,&Pubkey::new_from_array(c.migrated_pool))?;
    account(pool,&DAMM,&DAMM_DISC,1112)?;let p=pool.try_borrow_data()?;
    require(key(&p,168)?.to_bytes()==c.mint && key(&p,200)?==WSOL && p[484]==1 && p[480]==1 && p[481]==0
        && u64_at(&p,8)?==12_500_000 && p[16..40].iter().all(|b|*b==0) && p[56]==0
        && p[48]==20 && p[54]==0 && p[55]==0 && p[482]==0 && p[483]==0)
}
fn nft_position(c:&Coin,position:&AccountInfo,nft:&AccountInfo,authority:&Pubkey)->ProgramResult{
    key_is(position,&Pubkey::new_from_array(c.position))?;key_is(nft,&Pubkey::new_from_array(c.nft_account))?;
    account(position,&DAMM,&POSITION_DISC,408)?;
    let p=position.try_borrow_data()?;
    require(key(&p,8)?.to_bytes()==c.migrated_pool && u128_at(&p,152)?==0 && u128_at(&p,168)?==0 && u128_at(&p,184)?>0)?;
    require(nft.owner==&spl_token::id() || nft.owner==&TOKEN_2022)?;
    let n=nft.try_borrow_data()?;
    let value=TokenAccount::unpack_from_slice(n.get(..TokenAccount::LEN).ok_or(ProgramError::InvalidAccountData)?)?;
    require(value.state==spl_token::state::AccountState::Initialized && value.owner==*authority
        && value.mint==key(&p,40)? && value.amount==1 && value.delegate==solana_program::program_option::COption::None
        && value.close_authority==solana_program::program_option::COption::None)?;
    let expected=Pubkey::find_program_address(&[b"position_nft_account",value.mint.as_ref()],&DAMM).0;
    key_is(nft,&expected)
}
fn bind(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    // operator,settings,coin,original DBC pool,config,migrated pool,position,NFT account
    require(a.len()==8 && data.is_empty())?;let s=settings(&a[1],program)?;work(&s,&a[0])?;let mut c=coin(&a[2],program)?;
    require(c.migrated_pool==[0;32] && c.position==[0;32] && c.nft_account==[0;32])?;
    dbc_pool(&c,&a[3],&a[4],program)?;require(a[3].try_borrow_data()?[305]==1)?;
    key_is(&a[5],&migrated_pool(&Pubkey::new_from_array(c.mint)))?;
    c.migrated_pool=a[5].key.to_bytes();c.position=a[6].key.to_bytes();c.nft_account=a[7].key.to_bytes();
    damm_pool(&c,&a[5])?;nft_position(&c,&a[6],&a[7],&fee_authority(program).0)?;save(&a[2],&c)
}

fn parse_funding(data:&[u8])->Result<([u8;32],[u8;32],Vec<(u8,u64)>,u64),ProgramError>{
    let mut r=Reader::new(data);let id=r.bytes()?;let commitment=r.bytes()?;let count=r.u16()?;
    require(id==commitment && commitment!=[0;32] && count>0 && count<=32)?;
    let mut events=Vec::with_capacity(count as usize);let mut total=0;
    for _ in 0..count{let phase=r.u8()?;let net=r.u64()?;require(phase<=1 && net>0)?;total=add(total,net)?;events.push((phase,net));}
    r.end()?;Ok((id,commitment,events,total))
}
pub fn allocate(c:&mut Coin,events:&[(u8,u64)],now:i64,early_damm:bool)->ProgramResult{
    for &(phase,net) in events{
        require(net>0 && phase<=1)?;
        if phase==0{
            let before=c.rinse_net;let next=add(before,net)?;
            let delta=((next as u128)*80/100-(before as u128)*80/100) as u64;
            c.rinse_net=next;c.buyback=add(c.buyback,delta)?;c.platform=add(c.platform,sub(net,delta)?)?;
        }else{
            require(early_damm || now>=c.activation.checked_add(27).ok_or(ProgramError::ArithmeticOverflow)?)?;
            let before=c.post_net;let next=add(before,net)?;let delta=next/2-before/2;
            c.post_net=next;
            if c.mode==0{c.creator_budget=add(c.creator_budget,delta)?;}else{c.community=add(c.community,delta)?;}
            c.platform=add(c.platform,sub(net,delta)?)?;
        }
    }Ok(())
}
fn funding_receipt<'a>(program:&Pubkey,payer:&AccountInfo<'a>,coin:&AccountInfo<'a>,receipt:&AccountInfo<'a>,system:&AccountInfo<'a>,
    id:[u8;32],commitment:[u8;32],total:u64,rinse_before:u64,post_before:u64)->ProgramResult{
    let bump=create(payer,receipt,system,program,&[b"funding",coin.key.as_ref(),&id],Funding::SPACE)?;
    save(receipt,&Funding{version:1,bump,coin:coin.key.to_bytes(),id,commitment,total,slot:Clock::get()?.slot,
        rinse_net_before:rinse_before,post_net_before:post_before})
}
fn allocate_collected(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    require(a.len()==5)?;let (id,commitment,events,total)=parse_funding(data)?;let s=settings(&a[1],program)?;work(&s,&a[0])?;
    let mut c=coin(&a[2],program)?;let before=(c.rinse_net,c.post_net);c.unallocated_collected=sub(c.unallocated_collected,total)?;
    require(c.migrated_pool!=[0;32] && events.iter().all(|(phase,_)|*phase==1))?;
    allocate(&mut c,&events,Clock::get()?.unix_timestamp,true)?;
    funding_receipt(program,&a[0],&a[2],&a[3],&a[4],id,commitment,total,before.0,before.1)?;
    save(&a[2],&c)?;solvent(&a[2],&c)
}
fn collect(program:&Pubkey,a:&[AccountInfo],data:&[u8],migrated:bool)->ProgramResult{
    require(a.len()==if migrated{24}else{23})?;
    let (id,commitment,events,total)=parse_funding(data)?;
    let s=settings(&a[1],program)?;work(&s,&a[0])?;let mut c=coin(&a[2],program)?;
    if migrated {require(events.iter().all(|(phase,_)|*phase==1))?;}
    let before=(c.rinse_net,c.post_net);let authority=fee_authority(program);
    key_is(&a[5],&authority.0)?;key_is(&a[6],&spl_token::id())?;key_is(&a[7],&system_program::id())?;
    let quote=token(&a[4],a[2].key,&WSOL)?;require(quote.amount==0)?;
    let quote_lamports=a[4].lamports();let coin_lamports=a[2].lamports();
    let metas=&a[9..];let instruction;
    let base_before=token(&metas[3],a[2].key,&Pubkey::new_from_array(c.mint))?.amount;
    if migrated{
        key_is(&a[8],&DAMM)?;require(a[8].executable)?;damm_pool(&c,&metas[1])?;
        nft_position(&c,&metas[2],&metas[9],&authority.0)?;
        key_is(&metas[0],&DAMM_AUTHORITY)?;key_is(&metas[3],&ata(a[2].key,&Pubkey::new_from_array(c.mint)))?;
        token(&metas[3],a[2].key,&Pubkey::new_from_array(c.mint))?;key_is(&metas[4],a[4].key)?;
        let p=metas[1].try_borrow_data()?;key_is(&metas[5],&key(&p,232)?)?;key_is(&metas[6],&key(&p,264)?)?;drop(p);
        key_is(&metas[7],&Pubkey::new_from_array(c.mint))?;key_is(&metas[8],&WSOL)?;key_is(&metas[10],&authority.0)?;
        for i in [11,12]{key_is(&metas[i],&spl_token::id())?;}key_is(&metas[13],&event_authority(&DAMM))?;key_is(&metas[14],&DAMM)?;
        let writable=[false,false,true,true,true,true,true,false,false,false,false,false,false,false,false];
        instruction=Instruction{program_id:DAMM,accounts:metas.iter().enumerate().map(|(i,v)|AccountMeta{pubkey:*v.key,is_signer:i==10,is_writable:writable[i]}).collect(),data:vec![180,38,154,17,133,33,162,211]};
    }else{
        key_is(&a[8],&DBC)?;require(a[8].executable)?;dbc_pool(&c,&metas[2],&metas[1],program)?;
        key_is(&metas[0],&DBC_AUTHORITY)?;token(&metas[3],a[2].key,&Pubkey::new_from_array(c.mint))?;key_is(&metas[4],a[4].key)?;
        let p=metas[2].try_borrow_data()?;key_is(&metas[5],&key(&p,168)?)?;key_is(&metas[6],&key(&p,200)?)?;drop(p);
        key_is(&metas[7],&Pubkey::new_from_array(c.mint))?;key_is(&metas[8],&WSOL)?;key_is(&metas[9],&authority.0)?;
        for i in [10,11]{key_is(&metas[i],&spl_token::id())?;}key_is(&metas[12],&event_authority(&DBC))?;key_is(&metas[13],&DBC)?;
        let mut payload=vec![84,191,71,50,9,162,55,193];payload.extend_from_slice(&0u64.to_le_bytes());payload.extend_from_slice(&total.to_le_bytes());payload.extend_from_slice(&0u32.to_le_bytes());
        let writable=[false,false,true,true,true,true,true,false,false,false,false,false,false,false];
        instruction=Instruction{program_id:DBC,accounts:metas.iter().enumerate().map(|(i,v)|AccountMeta{pubkey:*v.key,is_signer:i==9,is_writable:writable[i]}).collect(),data:payload};
    }
    invoke_signed(&instruction,metas,&[&[b"fee-authority",&[authority.1]]])?;
    require(token(&metas[3],a[2].key,&Pubkey::new_from_array(c.mint))?.amount==base_before)?;
    let received=token(&a[4],a[2].key,&WSOL)?.amount;
    require(if migrated{received>=total}else{received==total})?;
    close_quote(&a[4],&a[2],&a[6],&c)?;
    require(a[2].lamports()==add(coin_lamports,add(quote_lamports,received)?)?)?;
    if migrated{c.unallocated_collected=add(c.unallocated_collected,sub(received,total)?)?;}
    allocate(&mut c,&events,Clock::get()?.unix_timestamp,migrated)?;
    funding_receipt(program,&a[0],&a[2],&a[3],&a[7],id,commitment,total,before.0,before.1)?;
    save(&a[2],&c)?;solvent(&a[2],&c)
}

pub fn spot_minimum(amount:u64,sqrt_price:u128)->Result<u64,ProgramError>{
    require(amount>0 && sqrt_price>0)?;
    let price=U256::from(sqrt_price).checked_mul(U256::from(sqrt_price)).ok_or(ProgramError::ArithmeticOverflow)?;
    let value=(U256::from(amount)<<128).checked_mul(U256::from(9250u64)).ok_or(ProgramError::ArithmeticOverflow)?
        .checked_div(price).ok_or(ProgramError::InvalidArgument)?.checked_div(U256::from(10000u64)).ok_or(ProgramError::InvalidArgument)?;
    require(value<=U256::from(u64::MAX))?;Ok(value.as_u64())
}
fn buyback(program:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    let mut r=Reader::new(data);let nonce=r.u64()?;let amount=r.u64()?;let minimum=r.u64()?;let deadline=r.i64()?;
    let route=r.u8()?;let len=r.u16()? as usize;
    require(route<=1 && len<=512 && data.len()==r.at+len && amount>0 && minimum>0)?;
    let payload=&data[r.at..];
    let swap_disc=payload.get(..8).ok_or(ProgramError::InvalidInstructionData)?;
    require((swap_disc==[248,198,158,145,225,117,135,200] && payload.len()==24)
        || (swap_disc==[65,75,63,76,235,91,91,136] && payload.len()==25 && payload[24]==0))?;
    require(u64_at(payload,8)?==amount && u64_at(payload,16)?==minimum)?;
    require(a.len()==if route==0{23}else{22})?;
    let s=settings(&a[1],program)?;work(&s,&a[0])?;let mut c=coin(&a[2],program)?;let clock=Clock::get()?;
    require(clock.unix_timestamp>=c.activation.checked_add(27).ok_or(ProgramError::ArithmeticOverflow)?
        && deadline>=clock.unix_timestamp && deadline<=clock.unix_timestamp.checked_add(30).ok_or(ProgramError::ArithmeticOverflow)?
        && nonce==c.nonce && amount<=c.buyback)?;
    key_is(&a[5],&Pubkey::new_from_array(c.mint))?;let mint_before=mint(&a[5])?.supply;
    key_is(&a[6],&spl_token::id())?;
    require(token(&a[3],a[2].key,&WSOL)?.amount==0)?;
    let tokens_before=token(&a[4],a[2].key,&Pubkey::new_from_array(c.mint))?.amount;
    let coin_before=a[2].lamports();let quote_before=a[3].lamports();
    let metas=&a[8..];let reserves;let sqrt_price;let instruction;
    if route==0{
        key_is(&a[7],&DBC)?;require(a[7].executable)?;dbc_pool(&c,&metas[2],&metas[1],program)?;
        let p=metas[2].try_borrow_data()?;require(p[305]==0)?;reserves=u64_at(&p,240)?;sqrt_price=u128_at(&p,280)?;
        key_is(&metas[5],&key(&p,168)?)?;key_is(&metas[6],&key(&p,200)?)?;drop(p);
        key_is(&metas[0],&DBC_AUTHORITY)?;key_is(&metas[3],a[3].key)?;key_is(&metas[4],a[4].key)?;
        key_is(&metas[7],a[5].key)?;key_is(&metas[8],&WSOL)?;key_is(&metas[9],a[2].key)?;
        for i in [10,11]{key_is(&metas[i],&spl_token::id())?;}
        key_is(&metas[12],&DBC)?;key_is(&metas[13],&event_authority(&DBC))?;key_is(&metas[14],&DBC)?;
        let writable=[false,false,true,true,true,true,true,false,false,false,false,false,false,false,false];
        instruction=Instruction{program_id:DBC,accounts:metas.iter().enumerate().map(|(i,v)|AccountMeta{pubkey:*v.key,is_signer:i==9,is_writable:writable[i]}).collect(),data:payload.to_vec()};
    }else{
        key_is(&a[7],&DAMM)?;require(a[7].executable)?;damm_pool(&c,&metas[1])?;
        let p=metas[1].try_borrow_data()?;reserves=u64_at(&p,688)?;sqrt_price=u128_at(&p,456)?;
        key_is(&metas[4],&key(&p,232)?)?;key_is(&metas[5],&key(&p,264)?)?;drop(p);
        key_is(&metas[0],&DAMM_AUTHORITY)?;key_is(&metas[2],a[3].key)?;key_is(&metas[3],a[4].key)?;
        key_is(&metas[6],a[5].key)?;key_is(&metas[7],&WSOL)?;key_is(&metas[8],a[2].key)?;
        for i in [9,10]{key_is(&metas[i],&spl_token::id())?;}
        key_is(&metas[11],&DAMM)?;key_is(&metas[12],&event_authority(&DAMM))?;key_is(&metas[13],&DAMM)?;
        let writable=[false,true,true,true,true,true,false,false,false,false,false,false,false,false];
        instruction=Instruction{program_id:DAMM,accounts:metas.iter().enumerate().map(|(i,v)|AccountMeta{pubkey:*v.key,is_signer:i==8,is_writable:writable[i]}).collect(),data:payload.to_vec()};
    }
    require(reserves>0 && amount<=reserves/100 && minimum>=spot_minimum(amount,sqrt_price)?)?;
    // Fund only the canonical empty WSOL account; account rent and prior donations remain outside budgets.
    move_sol(&a[2],&a[3],amount)?;
    let mut sync=token_ix::sync_native(&spl_token::id(),a[3].key)?;
    // Include both sides of the caller-owned lamport move in the CPI checkpoint.
    // SPL sync_native consumes its first account and ignores this extra writable account.
    sync.accounts.push(AccountMeta::new(*a[2].key,false));
    invoke(&sync,&[a[3].clone(),a[2].clone(),a[6].clone()])?;
    let wrapped=token(&a[3],a[2].key,&WSOL)?.amount;
    require(wrapped>=amount)?;
    invoke_signed(&instruction,metas,&[&[b"coin",&c.mint,&[c.bump]]])?;
    let quote_after=token(&a[3],a[2].key,&WSOL)?.amount;
    let spent=sub(wrapped,quote_after)?;require(spent>0 && spent<=amount)?;
    let received=sub(token(&a[4],a[2].key,&Pubkey::new_from_array(c.mint))?.amount,tokens_before)?;
    require(received>=minimum)?;
    let burn=token_ix::burn(&spl_token::id(),a[4].key,a[5].key,a[2].key,&[],received)?;
    invoke_signed(&burn,&[a[4].clone(),a[5].clone(),a[2].clone(),a[6].clone()],&[&[b"coin",&c.mint,&[c.bump]]])?;
    require(token(&a[4],a[2].key,&Pubkey::new_from_array(c.mint))?.amount==tokens_before
        && mint(&a[5])?.supply==sub(mint_before,received)?)?;
    close_quote(&a[3],&a[2],&a[6],&c)?;
    require(a[2].lamports()==add(sub(coin_before,spent)?,quote_before)?)?;
    c.buyback=sub(c.buyback,spent)?;c.nonce=add(c.nonce,1)?;c.burned=add(c.burned,received)?;
    save(&a[2],&c)?;solvent(&a[2],&c)
}
