use borsh::{BorshDeserialize,BorshSerialize};
use rinsed_vault::{processor::*,state::*,validation::*};
use solana_program::{account_info::AccountInfo,entrypoint::ProgramResult,instruction::{AccountMeta,Instruction},program::invoke_signed,
    program_option::COption,program_pack::Pack,pubkey::Pubkey,rent::Rent,system_program,clock::Clock};
use solana_program_test::{processor,ProgramTest,ProgramTestContext};
use solana_sdk::{account::{Account,AccountSharedData},signature::{Keypair,Signer},transaction::Transaction};
use spl_token::state::{Account as TokenAccount,AccountState,Mint};

fn meta(k:Pubkey,w:bool,s:bool)->AccountMeta{AccountMeta{pubkey:k,is_writable:w,is_signer:s}}
fn state_account<T:State>(value:&T,owner:Pubkey,extra:u64)->Account{
    let mut data=T::MAGIC.to_vec();value.serialize(&mut data).unwrap();assert_eq!(data.len(),T::SPACE);
    Account{lamports:Rent::default().minimum_balance(T::SPACE)+extra,data,owner,executable:false,rent_epoch:0}
}
fn plain(data:Vec<u8>,owner:Pubkey)->Account{Account{lamports:Rent::default().minimum_balance(data.len()),data,owner,executable:false,rent_epoch:0}}
fn mint_account()->Account{
    let mut data=vec![0;Mint::LEN];Mint::pack(Mint{mint_authority:COption::None,supply:1_000_000_000_000_000,decimals:6,is_initialized:true,freeze_authority:COption::None},&mut data).unwrap();plain(data,spl_token::id())
}
fn token_account(owner:Pubkey,mint:Pubkey,amount:u64)->Account{
    let rent=Rent::default().minimum_balance(TokenAccount::LEN);let native=mint==WSOL;
    let mut data=vec![0;TokenAccount::LEN];TokenAccount::pack(TokenAccount{mint,owner,amount,delegate:COption::None,state:AccountState::Initialized,
        is_native:if native{COption::Some(rent)}else{COption::None},delegated_amount:0,close_authority:COption::None},&mut data).unwrap();
    Account{lamports:rent+if native{amount}else{0},data,owner:spl_token::id(),executable:false,rent_epoch:0}
}
fn set64(data:&mut[u8],at:usize,value:u64){data[at..at+8].copy_from_slice(&value.to_le_bytes());}
fn setkey(data:&mut[u8],at:usize,value:Pubkey){data[at..at+32].copy_from_slice(value.as_ref());}
fn valid_config(authority:Pubkey)->Vec<u8>{
    let mut cfg=vec![0;1048];cfg[..8].copy_from_slice(&CONFIG_DISC);setkey(&mut cfg,8,WSOL);setkey(&mut cfg,40,authority);
    set64(&mut cfg,104,900_000_000);set64(&mut cfg,112,3);set64(&mut cfg,120,3782);cfg[128..130].copy_from_slice(&9u16.to_le_bytes());
    for (at,value) in [(130,1),(233,1),(234,1),(235,6),(239,100),(243,6),(244,1),(246,1),(365,1)]{cfg[at]=value;}
    set64(&mut cfg,264,80_000_000_000);set64(&mut cfg,344,1_000_000_000_000_000);set64(&mut cfg,352,1_000_000_000_000_000);
    cfg[362..364].copy_from_slice(&125u16.to_le_bytes());cfg
}

// A deterministic DBC fixture tests the vault's real token-program CPIs, lamport settlement and
// atomic rollback. It does not stand in for a full Meteora AMM/graduation rehearsal.
fn mock_dbc(_id:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    let (_,bump)=Pubkey::find_program_address(&[b"pool_authority"],&DBC);
    if data[..8]==[84,191,71,50,9,162,55,193]{
        assert!(a[9].is_signer);assert_eq!(u64_at(data,8)?,0);let amount=u64_at(data,16)?;
        let ix=spl_token::instruction::transfer(&spl_token::id(),a[6].key,a[4].key,a[0].key,&[],amount)?;
        invoke_signed(&ix,&[a[6].clone(),a[4].clone(),a[0].clone(),a[11].clone()],&[&[b"pool_authority",&[bump]]])
    }else{
        assert!(a[9].is_signer);let amount=u64_at(data,8)?;
        let spend=spl_token::instruction::transfer(&spl_token::id(),a[3].key,a[6].key,a[9].key,&[],amount)?;
        solana_program::program::invoke(&spend,&[a[3].clone(),a[6].clone(),a[9].clone(),a[11].clone()])?;
        let receive=spl_token::instruction::transfer(&spl_token::id(),a[5].key,a[4].key,a[0].key,&[],amount)?;
        invoke_signed(&receive,&[a[5].clone(),a[4].clone(),a[0].clone(),a[10].clone()],&[&[b"pool_authority",&[bump]]])
    }
}
fn mock_damm(_id:&Pubkey,a:&[AccountInfo],data:&[u8])->ProgramResult{
    let (_,bump)=Pubkey::find_program_address(&[b"pool_authority"],&DAMM);
    if data==[180,38,154,17,133,33,162,211]{
        assert!(a[10].is_signer);
        let ix=spl_token::instruction::transfer(&spl_token::id(),a[6].key,a[4].key,a[0].key,&[],200)?;
        invoke_signed(&ix,&[a[6].clone(),a[4].clone(),a[0].clone(),a[12].clone()],&[&[b"pool_authority",&[bump]]])
    }else{
        assert!(a[8].is_signer);let amount=u64_at(data,8)?;
        let spend=spl_token::instruction::transfer(&spl_token::id(),a[2].key,a[5].key,a[8].key,&[],amount)?;
        solana_program::program::invoke(&spend,&[a[2].clone(),a[5].clone(),a[8].clone(),a[10].clone()])?;
        let receive=spl_token::instruction::transfer(&spl_token::id(),a[4].key,a[3].key,a[0].key,&[],amount)?;
        invoke_signed(&receive,&[a[4].clone(),a[3].clone(),a[0].clone(),a[9].clone()],&[&[b"pool_authority",&[bump]]])
    }
}

struct Harness{
    ctx:ProgramTestContext,id:Pubkey,operator:Keypair,governor:Keypair,creator:Keypair,treasury:Keypair,
    mint:Pubkey,pool:Pubkey,config:Pubkey,coin:Pubkey,settings:Pubkey,approval:Pubkey,
    quote:Pubkey,tokens:Pubkey,base_vault:Pubkey,quote_vault:Pubkey,sequence:u32,
}
impl Harness{
    async fn new(mode:u8)->Self{
        let id=Pubkey::new_unique();let operator=Keypair::new();let governor=Keypair::new();let creator=Keypair::new();let treasury=Keypair::new();
        let mint=Pubkey::new_unique();let pool=Pubkey::new_unique();let config=Pubkey::new_unique();
        let (settings,bump)=Pubkey::find_program_address(&[b"settings"],&id);
        let coin=Pubkey::find_program_address(&[b"coin",mint.as_ref()],&id).0;
        let approval=Pubkey::find_program_address(&[b"config",config.as_ref()],&id).0;
        let authority=fee_authority(&id).0;let quote=ata(&coin,&WSOL);let tokens=ata(&coin,&mint);
        let base_vault=Pubkey::new_unique();let quote_vault=Pubkey::new_unique();
        let sbf=std::env::var("RINSED_TEST_SBF").as_deref()==Ok("1");
        let mut test=if sbf{ProgramTest::default()}else{ProgramTest::new("rinsed_vault",id,processor!(rinsed_vault::process_instruction))};
        test.prefer_bpf(false); // Only the vault is loaded from ELF; fixture processors stay native.
        if sbf{
            use solana_sdk::bpf_loader_upgradeable::{self,UpgradeableLoaderState};
            let directory=std::env::var("SBF_OUT_DIR").or_else(|_|std::env::var("BPF_OUT_DIR")).expect("Set SBF_OUT_DIR to the built ELF directory");
            let elf=std::fs::read(std::path::Path::new(&directory).join("rinsed_vault.so")).expect("Build the SBF artifact first");
            let programdata=Pubkey::find_program_address(&[id.as_ref()],&bpf_loader_upgradeable::id()).0;
            test.add_account(id,Account{lamports:Rent::default().minimum_balance(36),data:bincode::serialize(&UpgradeableLoaderState::Program{programdata_address:programdata}).unwrap(),owner:bpf_loader_upgradeable::id(),executable:true,rent_epoch:0});
            let mut deployed=bincode::serialize(&UpgradeableLoaderState::ProgramData{slot:0,upgrade_authority_address:Some(governor.pubkey())}).unwrap();deployed.extend(elf);
            test.add_account(programdata,plain(deployed,bpf_loader_upgradeable::id()));
        }
        test.add_program("spl_token",spl_token::id(),processor!(spl_token::processor::Processor::process));
        test.add_program("mock_dbc",DBC,processor!(mock_dbc));
        test.add_program("mock_damm",DAMM,processor!(mock_damm));
        for wallet in [&operator,&governor,&creator,&treasury]{test.add_account(wallet.pubkey(),Account{lamports:10_000_000_000,data:vec![],owner:system_program::id(),executable:false,rent_epoch:0});}
        if !sbf{test.add_account(settings,state_account(&Settings{version:1,bump,paused:0,governor:governor.pubkey().to_bytes(),operator:operator.pubkey().to_bytes(),treasury:treasury.pubkey().to_bytes()},id,0));}
        test.add_account(config,plain(valid_config(authority),DBC));
        let mut p=vec![0;424];p[..8].copy_from_slice(&POOL_DISC);setkey(&mut p,72,config);setkey(&mut p,104,creator.pubkey());
        setkey(&mut p,136,mint);setkey(&mut p,168,base_vault);setkey(&mut p,200,quote_vault);set64(&mut p,240,10_000);
        p[280..296].copy_from_slice(&(1u128<<64).to_le_bytes());set64(&mut p,296,7190);test.add_account(pool,plain(p,DBC));
        test.add_account(mint,mint_account());test.add_account(base_vault,token_account(DBC_AUTHORITY,mint,1_000_000));
        test.add_account(quote_vault,token_account(DBC_AUTHORITY,WSOL,1_000_000_000));
        test.add_account(quote,token_account(coin,WSOL,0));test.add_account(tokens,token_account(coin,mint,7));
        let ctx=test.start_with_context().await;let mut h=Self{ctx,id,operator,governor,creator,treasury,mint,pool,config,coin,settings,approval,quote,tokens,base_vault,quote_vault,sequence:0};
        h.clock(7200);
        if sbf{
            use solana_sdk::bpf_loader_upgradeable;
            let programdata=Pubkey::find_program_address(&[id.as_ref()],&bpf_loader_upgradeable::id()).0;
            let mut data=INITIALIZE.to_vec();data.extend_from_slice(h.operator.pubkey().as_ref());data.extend_from_slice(h.treasury.pubkey().as_ref());data.push(0);
            let initialize=Instruction{program_id:id,accounts:vec![meta(h.governor.pubkey(),true,true),meta(settings,true,false),meta(id,false,false),meta(programdata,false,false),meta(system_program::id(),false,false)],data};
            let mut takeover=initialize.clone();takeover.accounts[0]=meta(h.operator.pubkey(),true,true);
            assert!(!h.send(takeover,2).await);assert!(h.send(initialize.clone(),0).await);assert!(!h.send(initialize,0).await);
        }
        let approve=Instruction{program_id:id,accounts:vec![meta(h.governor.pubkey(),true,true),meta(settings,false,false),meta(approval,true,false),meta(config,false,false),meta(system_program::id(),false,false)],data:APPROVE.to_vec()};
        assert!(h.send(approve,0).await);
        let register=Instruction{program_id:id,accounts:vec![meta(h.creator.pubkey(),true,true),meta(settings,false,false),meta(coin,true,false),meta(mint,false,false),meta(pool,false,false),meta(config,false,false),meta(approval,false,false),meta(system_program::id(),false,false)],data:[REGISTER.as_slice(),&[mode]].concat()};
        assert!(h.send(register,1).await);h
    }
    fn clock(&mut self,time:i64){self.ctx.set_sysvar(&Clock{slot:100,epoch_start_timestamp:0,epoch:0,leader_schedule_epoch:0,unix_timestamp:time});}
    async fn send(&mut self,ix:Instruction,who:u8)->bool{
        self.sequence+=1;
        let wallet=match who{0=>&self.governor,1=>&self.creator,2=>&self.operator,_=>&self.treasury};
        let blockhash=self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let unique=solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(250_000+self.sequence);
        let tx=Transaction::new_signed_with_payer(&[unique,ix],Some(&self.ctx.payer.pubkey()),&[&self.ctx.payer,wallet],blockhash);
        self.ctx.banks_client.process_transaction(tx).await.is_ok()
    }
    async fn state<T:State>(&mut self,key:Pubkey)->T{
        let account=self.ctx.banks_client.get_account(key).await.unwrap().unwrap();T::try_from_slice(&account.data[8..]).unwrap()
    }
    fn reset_quote(&mut self){self.ctx.set_account(&self.quote,&AccountSharedData::from(token_account(self.coin,WSOL,0)));}
    fn fund(&self,tag:u8,phase:u8,amount:u64)->Instruction{
        let commitment=[tag;32];let receipt=Pubkey::find_program_address(&[b"funding",self.coin.as_ref(),&commitment],&self.id).0;
        let mut data=COLLECT.to_vec();data.extend_from_slice(&commitment);data.extend_from_slice(&commitment);data.extend_from_slice(&1u16.to_le_bytes());data.push(phase);data.extend_from_slice(&amount.to_le_bytes());
        let mut keys=vec![meta(self.operator.pubkey(),true,true),meta(self.settings,false,false),meta(self.coin,true,false),meta(receipt,true,false),meta(self.quote,true,false),meta(fee_authority(&self.id).0,false,false),meta(spl_token::id(),false,false),meta(system_program::id(),false,false),meta(DBC,false,false)];
        keys.extend([meta(DBC_AUTHORITY,false,false),meta(self.config,false,false),meta(self.pool,true,false),meta(self.tokens,true,false),meta(self.quote,true,false),meta(self.base_vault,true,false),meta(self.quote_vault,true,false),meta(self.mint,false,false),meta(WSOL,false,false),meta(fee_authority(&self.id).0,false,false),meta(spl_token::id(),false,false),meta(spl_token::id(),false,false),meta(Pubkey::find_program_address(&[b"__event_authority"],&DBC).0,false,false),meta(DBC,false,false)]);
        Instruction{program_id:self.id,accounts:keys,data}
    }
    fn buy(&self,nonce:u64,amount:u64,min:u64,deadline:i64)->Instruction{
        let mut swap=vec![248,198,158,145,225,117,135,200];swap.extend_from_slice(&amount.to_le_bytes());swap.extend_from_slice(&min.to_le_bytes());
        let mut data=BUYBACK.to_vec();data.extend_from_slice(&nonce.to_le_bytes());data.extend_from_slice(&amount.to_le_bytes());data.extend_from_slice(&min.to_le_bytes());data.extend_from_slice(&deadline.to_le_bytes());data.push(0);data.extend_from_slice(&(swap.len() as u16).to_le_bytes());data.extend(swap);
        let mut keys=vec![meta(self.operator.pubkey(),true,true),meta(self.settings,false,false),meta(self.coin,true,false),meta(self.quote,true,false),meta(self.tokens,true,false),meta(self.mint,true,false),meta(spl_token::id(),false,false),meta(DBC,false,false)];
        keys.extend([meta(DBC_AUTHORITY,false,false),meta(self.config,false,false),meta(self.pool,true,false),meta(self.quote,true,false),meta(self.tokens,true,false),meta(self.base_vault,true,false),meta(self.quote_vault,true,false),meta(self.mint,false,false),meta(WSOL,false,false),meta(self.coin,false,false),meta(spl_token::id(),false,false),meta(spl_token::id(),false,false),meta(DBC,false,false),meta(Pubkey::find_program_address(&[b"__event_authority"],&DBC).0,false,false),meta(DBC,false,false)]);
        Instruction{program_id:self.id,accounts:keys,data}
    }
}

#[tokio::test]
async fn funding_atomic_burn_and_funded_claims_resist_replay_and_wrong_authority(){
    let mut h=Harness::new(1).await;
    let mut wrong_operator=h.fund(9,0,120);wrong_operator.accounts[0]=meta(h.creator.pubkey(),true,true);
    assert!(!h.send(wrong_operator,1).await);
    let funding=h.fund(1,0,120);assert!(h.send(funding.clone(),2).await);
    let c:Coin=h.state(h.coin).await;assert_eq!(c.buyback,96);assert_eq!(c.community,0);assert_eq!(c.platform,24);
    h.reset_quote();assert!(!h.send(funding,2).await);assert_eq!(h.state::<Coin>(h.coin).await.buyback,96);
    assert!(!h.send(h.buy(0,90,84,7220),2).await); // RINSE is still active.
    h.clock(7220);assert!(!h.send(h.buy(0,90,1,7240),2).await); // Operator cannot defeat the spot-price bound.
    assert!(!h.send(h.buy(1,90,84,7240),2).await);assert!(!h.send(h.buy(0,90,84,7251),2).await);
    let mint_before=h.ctx.banks_client.get_account(h.mint).await.unwrap().unwrap();let supply=Mint::unpack(&mint_before.data).unwrap().supply;
    assert!(h.send(h.buy(0,90,84,7240),2).await);
    let c:Coin=h.state(h.coin).await;assert_eq!((c.buyback,c.nonce,c.burned),(6,1,90));
    let account=h.ctx.banks_client.get_account(h.tokens).await.unwrap().unwrap();assert_eq!(TokenAccount::unpack(&account.data).unwrap().amount,7);
    let m=h.ctx.banks_client.get_account(h.mint).await.unwrap().unwrap();assert_eq!(Mint::unpack(&m.data).unwrap().supply,supply-90);
    h.reset_quote();assert!(!h.send(h.buy(0,1,1,7240),2).await);
    assert!(h.send(h.fund(2,1,100_000_001),2).await);
    let c:Coin=h.state(h.coin).await;assert_eq!(c.community,50_000_000);assert_eq!(c.post_net,100_000_001);
    let amount=50_000_000;let epoch=1u64;let root=merkle_leaf(&h.id,&h.coin,epoch,&h.creator.pubkey(),amount);
    let epoch_key=Pubkey::find_program_address(&[b"epoch",h.coin.as_ref(),&epoch.to_le_bytes()],&h.id).0;
    let mut data=CREATE_EPOCH.to_vec();data.extend_from_slice(&epoch.to_le_bytes());data.extend_from_slice(&root);data.extend_from_slice(&99u64.to_le_bytes());data.extend_from_slice(&[7;32]);data.extend_from_slice(&amount.to_le_bytes());
    let publish=Instruction{program_id:h.id,accounts:vec![meta(h.operator.pubkey(),true,true),meta(h.settings,false,false),meta(h.coin,true,false),meta(epoch_key,true,false),meta(system_program::id(),false,false)],data};
    assert!(h.send(publish.clone(),2).await);assert!(!h.send(publish,2).await);assert_eq!(h.state::<Coin>(h.coin).await.community,0);
    let mut pause=PAUSE.to_vec();pause.push(1);
    assert!(h.send(Instruction{program_id:h.id,accounts:vec![meta(h.governor.pubkey(),false,true),meta(h.settings,true,false)],data:pause},0).await);
    let claim_key=Pubkey::find_program_address(&[b"claim",epoch_key.as_ref(),h.creator.pubkey().as_ref()],&h.id).0;
    let mut claim=CLAIM_COMMUNITY.to_vec();claim.extend_from_slice(&epoch.to_le_bytes());claim.extend_from_slice(&amount.to_le_bytes());claim.extend_from_slice(&0u16.to_le_bytes());
    let withdraw=Instruction{program_id:h.id,accounts:vec![meta(h.creator.pubkey(),true,true),meta(h.coin,false,false),meta(epoch_key,true,false),meta(claim_key,true,false),meta(system_program::id(),false,false)],data:claim};
    let mut stolen=withdraw.clone();stolen.accounts[0]=meta(h.operator.pubkey(),true,true);
    stolen.accounts[3]=meta(Pubkey::find_program_address(&[b"claim",epoch_key.as_ref(),h.operator.pubkey().as_ref()],&h.id).0,true,false);
    assert!(!h.send(stolen,2).await);
    assert!(h.send(withdraw.clone(),1).await);assert!(!h.send(withdraw,1).await);assert_eq!(h.state::<Epoch>(epoch_key).await.remaining,0);
    assert_eq!(h.state::<Claim>(claim_key).await.amount,amount);
    let creator_claim=Instruction{program_id:h.id,accounts:vec![meta(h.creator.pubkey(),true,true),meta(h.coin,true,false)],data:[CLAIM_CREATOR.as_slice(),&1u64.to_le_bytes()].concat()};
    assert!(!h.send(creator_claim,1).await); // Community cannot be reinterpreted as Creator mode.
}

#[tokio::test]
async fn creator_and_platform_rights_cannot_withdraw_donations_or_each_others_budget(){
    let mut h=Harness::new(0).await;h.clock(7220);
    assert!(h.send(h.fund(8,1,10_000_000),2).await);
    let mut creator_claim=Instruction{program_id:h.id,accounts:vec![meta(h.creator.pubkey(),true,true),meta(h.coin,true,false)],data:[CLAIM_CREATOR.as_slice(),&5_000_001u64.to_le_bytes()].concat()};
    assert!(!h.send(creator_claim.clone(),1).await); // Closed ATA rent is not a reward budget.
    creator_claim.data=[CLAIM_CREATOR.as_slice(),&5_000_000u64.to_le_bytes()].concat();
    let mut stolen=creator_claim.clone();stolen.accounts[0]=meta(h.operator.pubkey(),true,true);assert!(!h.send(stolen,2).await);
    assert!(h.send(creator_claim.clone(),1).await);assert!(!h.send(creator_claim,1).await);
    let mut platform=Instruction{program_id:h.id,accounts:vec![meta(h.operator.pubkey(),true,true),meta(h.coin,true,false),meta(h.settings,false,false)],data:[CLAIM_PLATFORM.as_slice(),&5_000_000u64.to_le_bytes()].concat()};
    assert!(!h.send(platform.clone(),2).await);platform.accounts[0]=meta(h.treasury.pubkey(),true,true);
    assert!(h.send(platform,3).await);let c:Coin=h.state(h.coin).await;assert_eq!((c.creator_budget,c.platform),(0,0));
    assert!(h.ctx.banks_client.get_account(h.coin).await.unwrap().unwrap().lamports>Rent::default().minimum_balance(Coin::SPACE));
}

#[tokio::test]
async fn damm_claim_all_excess_requires_separate_immutable_allocation_receipt(){
    let mut h=Harness::new(0).await;
    let mut dbc=h.ctx.banks_client.get_account(h.pool).await.unwrap().unwrap();dbc.data[305]=1;
    h.ctx.set_account(&h.pool,&AccountSharedData::from(dbc));
    let pool=migrated_pool(&h.mint);let position=Pubkey::new_unique();let nft_mint=Pubkey::new_unique();
    let nft=Pubkey::find_program_address(&[b"position_nft_account",nft_mint.as_ref()],&DAMM).0;
    let base_vault=Pubkey::new_unique();let quote_vault=Pubkey::new_unique();
    let mut p=vec![0;1112];p[..8].copy_from_slice(&DAMM_DISC);set64(&mut p,8,12_500_000);p[48]=20;
    setkey(&mut p,168,h.mint);setkey(&mut p,200,WSOL);setkey(&mut p,232,base_vault);setkey(&mut p,264,quote_vault);
    p[360..376].copy_from_slice(&1000u128.to_le_bytes());p[456..472].copy_from_slice(&(1u128<<64).to_le_bytes());
    set64(&mut p,472,7195);p[480]=1;p[484]=1;set64(&mut p,688,10_000);
    h.ctx.set_account(&pool,&AccountSharedData::from(plain(p,DAMM)));
    let mut pos=vec![0;408];pos[..8].copy_from_slice(&POSITION_DISC);setkey(&mut pos,8,pool);setkey(&mut pos,40,nft_mint);
    pos[184..200].copy_from_slice(&1000u128.to_le_bytes());h.ctx.set_account(&position,&AccountSharedData::from(plain(pos,DAMM)));
    h.ctx.set_account(&nft,&AccountSharedData::from(token_account(fee_authority(&h.id).0,nft_mint,1)));
    h.ctx.set_account(&base_vault,&AccountSharedData::from(token_account(DAMM_AUTHORITY,h.mint,10000)));
    h.ctx.set_account(&quote_vault,&AccountSharedData::from(token_account(DAMM_AUTHORITY,WSOL,1_000_000)));
    let bind=Instruction{program_id:h.id,accounts:vec![meta(h.operator.pubkey(),false,true),meta(h.settings,false,false),meta(h.coin,true,false),meta(h.pool,false,false),meta(h.config,false,false),meta(pool,false,false),meta(position,false,false),meta(nft,false,false)],data:BIND.to_vec()};
    let mut wrong=bind.clone();wrong.accounts[5]=meta(h.pool,false,false);assert!(!h.send(wrong,2).await);
    assert!(h.send(bind.clone(),2).await);assert!(!h.send(bind,2).await);
    let id=[41u8;32];let funding=Pubkey::find_program_address(&[b"funding",h.coin.as_ref(),&id],&h.id).0;
    let mut data=COLLECT_DAMM.to_vec();data.extend(id);data.extend(id);data.extend(1u16.to_le_bytes());data.push(1);data.extend(100u64.to_le_bytes());
    let mut keys=vec![meta(h.operator.pubkey(),true,true),meta(h.settings,false,false),meta(h.coin,true,false),meta(funding,true,false),meta(h.quote,true,false),meta(fee_authority(&h.id).0,false,false),meta(spl_token::id(),false,false),meta(system_program::id(),false,false),meta(DAMM,false,false)];
    keys.extend([meta(DAMM_AUTHORITY,false,false),meta(pool,false,false),meta(position,true,false),meta(h.tokens,true,false),meta(h.quote,true,false),meta(base_vault,true,false),meta(quote_vault,true,false),meta(h.mint,false,false),meta(WSOL,false,false),meta(nft,false,false),meta(fee_authority(&h.id).0,false,false),meta(spl_token::id(),false,false),meta(spl_token::id(),false,false),meta(Pubkey::find_program_address(&[b"__event_authority"],&DAMM).0,false,false),meta(DAMM,false,false)]);
    assert!(h.send(Instruction{program_id:h.id,accounts:keys,data},2).await);
    let state:Coin=h.state(h.coin).await;assert_eq!((state.creator_budget,state.platform,state.unallocated_collected,state.post_net),(50,50,100,100));
    let receipt:Funding=h.state(funding).await;assert_eq!((receipt.total,receipt.post_net_before),(100,0));
    let id=[42u8;32];let allocation=Pubkey::find_program_address(&[b"funding",h.coin.as_ref(),&id],&h.id).0;
    let mut data=solana_program::hash::hash(b"global:allocate_collected_fees").to_bytes()[..8].to_vec();data.extend(id);data.extend(id);data.extend(1u16.to_le_bytes());data.push(1);data.extend(100u64.to_le_bytes());
    let allocate=Instruction{program_id:h.id,accounts:vec![meta(h.operator.pubkey(),true,true),meta(h.settings,false,false),meta(h.coin,true,false),meta(allocation,true,false),meta(system_program::id(),false,false)],data};
    let before=h.ctx.banks_client.get_account(h.coin).await.unwrap().unwrap().lamports;
    assert!(h.send(allocate.clone(),2).await);assert!(!h.send(allocate,2).await);
    assert_eq!(h.ctx.banks_client.get_account(h.coin).await.unwrap().unwrap().lamports,before);
    let state:Coin=h.state(h.coin).await;assert_eq!((state.creator_budget,state.platform,state.unallocated_collected,state.post_net),(100,100,0,200));
    let receipt:Funding=h.state(allocation).await;assert_eq!((receipt.total,receipt.post_net_before),(100,100));
}

#[test]
fn cumulative_rounding_and_proof_domain_are_stable(){
    let mut c=Coin{version:1,bump:1,mode:0,mint:[1;32],pool:[2;32],config:[3;32],creator:[4;32],activation:0,
        buyback:0,creator_budget:0,community:0,platform:0,nonce:0,burned:0,migrated_pool:[0;32],position:[0;32],nft_account:[0;32],config_hash:[0;32],rinse_net:0,post_net:0,unallocated_collected:0};
    allocate(&mut c,&[(0,1),(0,1),(0,1),(0,1),(0,1)],30,false).unwrap();assert_eq!((c.buyback,c.platform),(4,1));
    allocate(&mut c,&[(1,1),(1,1),(1,1)],30,false).unwrap();assert_eq!((c.creator_budget,c.community,c.post_net),(1,0,3));
    assert_eq!(c.liabilities().unwrap(),8);assert!(allocate(&mut c,&[(1,1)],1,false).is_err());
    let id=Pubkey::new_unique();let coin=Pubkey::new_unique();let wallet=Pubkey::new_unique();
    assert_ne!(merkle_leaf(&id,&coin,1,&wallet,10),merkle_leaf(&id,&coin,2,&wallet,10));
    assert_ne!(merkle_leaf(&id,&coin,1,&wallet,10),merkle_leaf(&id,&Pubkey::new_unique(),1,&wallet,10));
    assert_eq!(spot_minimum(100,1u128<<64).unwrap(),92);assert!(spot_minimum(100,0).is_err());
}

#[test]
fn initialization_requires_actual_loader_upgrade_authority(){
    use solana_program::{account_info::AccountInfo,bpf_loader_upgradeable::{self,UpgradeableLoaderState}};
    let id=Pubkey::new_unique();let governor=Pubkey::new_unique();let attacker=Pubkey::new_unique();
    let settings=Pubkey::find_program_address(&[b"settings"],&id).0;
    let programdata=Pubkey::find_program_address(&[id.as_ref()],&bpf_loader_upgradeable::id()).0;
    let loader=bpf_loader_upgradeable::id();let system=system_program::id();
    let mut wallet_lamports=10_000_000;let mut settings_lamports=0;let mut executable_lamports=1;let mut metadata_lamports=1;let mut system_lamports=1;
    let mut wallet_data=[];let mut settings_data=[];let mut system_data=[];
    let mut program_data=bincode::serialize(&UpgradeableLoaderState::Program{programdata_address:programdata}).unwrap();
    let mut metadata=bincode::serialize(&UpgradeableLoaderState::ProgramData{slot:1,upgrade_authority_address:Some(governor)}).unwrap();
    let accounts=vec![AccountInfo::new(&attacker,true,true,&mut wallet_lamports,&mut wallet_data,&system,false,0),
        AccountInfo::new(&settings,false,true,&mut settings_lamports,&mut settings_data,&system,false,0),
        AccountInfo::new(&id,false,false,&mut executable_lamports,&mut program_data,&loader,true,0),
        AccountInfo::new(&programdata,false,false,&mut metadata_lamports,&mut metadata,&loader,false,0),
        AccountInfo::new(&system,false,false,&mut system_lamports,&mut system_data,&system,true,0)];
    let mut data=INITIALIZE.to_vec();data.extend_from_slice(Pubkey::new_unique().as_ref());data.extend_from_slice(Pubkey::new_unique().as_ref());data.push(0);
    assert!(rinsed_vault::process_instruction(&id,&accounts,&data).is_err());
}

#[test]
fn policy_rejects_legacy_dynamic_and_uncollectable_extra_fees(){
    let authority=Pubkey::new_unique();let key=Pubkey::new_unique();
    let cfg=valid_config(authority);
    for changed in [None,Some(136usize),Some(247),Some(248),Some(368)]{
        let mut data=cfg.clone();if let Some(offset)=changed{data[offset]=1;}
        let mut lamports=1;let account=AccountInfo::new(&key,false,false,&mut lamports,&mut data,&DBC,false,0);
        assert_eq!(rinsed_vault::validation::config(&account,&authority).is_ok(),changed.is_none());
    }
}
