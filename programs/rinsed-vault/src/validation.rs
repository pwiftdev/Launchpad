use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, hash::hash};
use solana_program::program_pack::Pack;
use spl_token::state::{Account, AccountState, Mint};
use solana_program::program_option::COption;

pub const DBC: Pubkey = solana_program::pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM: Pubkey = solana_program::pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const ATA: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");
pub const TOKEN_2022: Pubkey = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const DBC_AUTHORITY: Pubkey = solana_program::pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DAMM_AUTHORITY: Pubkey = solana_program::pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_CONFIG: Pubkey = solana_program::pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
pub const CONFIG_DISC: [u8;8] = [26,108,14,123,116,230,129,43];
pub const POOL_DISC: [u8;8] = [213,224,5,209,98,69,119,92];
pub const DAMM_DISC: [u8;8] = [241,154,109,4,17,177,109,188];
pub const POSITION_DISC: [u8;8] = [170,188,143,228,122,64,247,208];

pub fn require(ok: bool) -> Result<(),ProgramError> { if ok {Ok(())} else {Err(ProgramError::InvalidArgument)} }
pub fn key(data:&[u8], offset:usize) -> Result<Pubkey,ProgramError> {
    let bytes=data.get(offset..offset+32).ok_or(ProgramError::InvalidAccountData)?;
    Ok(Pubkey::new_from_array(bytes.try_into().map_err(|_|ProgramError::InvalidAccountData)?))
}
pub fn u64_at(data:&[u8],offset:usize)->Result<u64,ProgramError> {
    Ok(u64::from_le_bytes(data.get(offset..offset+8).ok_or(ProgramError::InvalidAccountData)?.try_into().map_err(|_|ProgramError::InvalidAccountData)?))
}
pub fn u128_at(data:&[u8],offset:usize)->Result<u128,ProgramError> {
    Ok(u128::from_le_bytes(data.get(offset..offset+16).ok_or(ProgramError::InvalidAccountData)?.try_into().map_err(|_|ProgramError::InvalidAccountData)?))
}
pub fn account(data:&AccountInfo,owner:&Pubkey,disc:&[u8;8],len:usize)->Result<(),ProgramError> {
    require(data.owner==owner)?;
    let bytes=data.try_borrow_data()?;
    require(bytes.len()==len && bytes.get(..8)==Some(disc.as_slice()))
}
pub fn fee_authority(program:&Pubkey)->(Pubkey,u8){ Pubkey::find_program_address(&[b"fee-authority"],program) }
pub fn ata(owner:&Pubkey,mint:&Pubkey)->Pubkey{
    Pubkey::find_program_address(&[owner.as_ref(),spl_token::id().as_ref(),mint.as_ref()],&ATA).0
}
pub fn mint(account:&AccountInfo)->Result<Mint,ProgramError>{
    require(account.owner==&spl_token::id())?;
    let value=Mint::unpack(&account.try_borrow_data()?)?;
    require(value.is_initialized && value.decimals==6 && value.mint_authority==COption::None && value.freeze_authority==COption::None)?;
    Ok(value)
}
pub fn token(account:&AccountInfo,owner:&Pubkey,mint:&Pubkey)->Result<Account,ProgramError>{
    require(account.owner==&spl_token::id() && account.key==&ata(owner,mint))?;
    let value=Account::unpack(&account.try_borrow_data()?)?;
    require(value.state==AccountState::Initialized && value.owner==*owner && value.mint==*mint
        && value.delegate==COption::None && value.close_authority==COption::None)?;
    if mint==&WSOL { require(value.is_native.is_some())?; }
    Ok(value)
}
pub fn config(account:&AccountInfo,authority:&Pubkey)->Result<[u8;32],ProgramError>{
    self::account(account,&DBC,&CONFIG_DISC,1048)?;
    let data=account.try_borrow_data()?;
    require(key(&data,8)?==WSOL && key(&data,40)?==*authority)?;
    require(u64_at(&data,104)?==900_000_000 && u64_at(&data,112)?==3 && u64_at(&data,120)?==3782)?;
    require(u16::from_le_bytes([data[128],data[129]])==9 && data[130]==1 && data[136]==0)?;
    for (offset,value) in [(232,0),(233,1),(234,1),(235,6),(237,0),(238,0),(239,100),(240,0),(241,0),(242,0),(243,6),(244,1),(245,0),(246,1),(360,0),(361,0),(364,0),(365,1)] {
        require(data[offset]==value)?;
    }
    require(u16::from_le_bytes([data[362],data[363]])==125 && u16::from_le_bytes([data[366],data[367]])==0)?;
    require(u64_at(&data,264)?==80_000_000_000 && u64_at(&data,344)?==1_000_000_000_000_000
        && u64_at(&data,352)?==1_000_000_000_000_000)?;
    require(data[247]==0 && data[248]==0 && u64_at(&data,368)?==0)?;
    // A nonzero vesting grant or mutable supply would create rights outside the fixed vault policy.
    require(data[184]==0 && data[200]==0 && data[296..344].iter().all(|b|*b==0))?;
    Ok(hash(&data).to_bytes())
}
pub fn migrated_pool(mint:&Pubkey)->Pubkey{
    let (first,second)=if mint.to_bytes()>WSOL.to_bytes(){(mint, &WSOL)}else{(&WSOL,mint)};
    Pubkey::find_program_address(&[b"pool",DAMM_CONFIG.as_ref(),first.as_ref(),second.as_ref()],&DAMM).0
}
