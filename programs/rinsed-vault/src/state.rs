use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

pub trait State: BorshSerialize + BorshDeserialize {
    const MAGIC: [u8; 8];
    const SPACE: usize;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Settings {
    pub version: u8, pub bump: u8, pub paused: u8,
    pub governor: [u8; 32], pub operator: [u8; 32], pub treasury: [u8; 32],
}
impl State for Settings { const MAGIC: [u8;8] = *b"RSET0001"; const SPACE: usize = 107; }

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct ConfigApproval {
    pub version: u8, pub bump: u8, pub config: [u8;32], pub digest: [u8;32],
}
impl State for ConfigApproval { const MAGIC: [u8;8] = *b"RCONF001"; const SPACE: usize = 74; }

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Coin {
    pub version: u8, pub bump: u8, pub mode: u8,
    pub mint: [u8;32], pub pool: [u8;32], pub config: [u8;32], pub creator: [u8;32],
    pub activation: i64,
    pub buyback: u64, pub creator_budget: u64, pub community: u64, pub platform: u64,
    pub nonce: u64, pub burned: u64,
    pub migrated_pool: [u8;32], pub position: [u8;32], pub nft_account: [u8;32],
    pub config_hash: [u8;32],
    pub rinse_net: u64, pub post_net: u64, pub unallocated_collected: u64,
}
impl State for Coin { const MAGIC: [u8;8] = *b"RCOIN001"; const SPACE: usize = 347; }
impl Coin {
    pub fn liabilities(&self) -> Result<u64,ProgramError> {
        self.buyback.checked_add(self.creator_budget).and_then(|v|v.checked_add(self.community))
            .and_then(|v|v.checked_add(self.platform)).and_then(|v|v.checked_add(self.unallocated_collected)).ok_or(ProgramError::ArithmeticOverflow)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Funding {
    pub version: u8, pub bump: u8, pub coin: [u8;32], pub id: [u8;32],
    pub commitment: [u8;32], pub total: u64, pub slot: u64,
    pub rinse_net_before: u64, pub post_net_before: u64,
}
impl State for Funding { const MAGIC:[u8;8] = *b"RFUND001"; const SPACE:usize = 138; }

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Epoch {
    pub version: u8, pub bump: u8, pub coin: [u8;32], pub epoch: u64,
    pub root: [u8;32], pub snapshot_slot: u64, pub snapshot_digest: [u8;32],
    pub total: u64, pub remaining: u64,
}
impl State for Epoch { const MAGIC:[u8;8] = *b"REPOCH01"; const SPACE:usize = 138; }

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Claim {
    pub version: u8, pub bump: u8, pub epoch: [u8;32], pub wallet: [u8;32], pub amount: u64,
}
impl State for Claim { const MAGIC:[u8;8] = *b"RCLAIM01"; const SPACE:usize = 82; }

pub fn load<T: State>(account: &AccountInfo, program: &Pubkey) -> Result<T,ProgramError> {
    if account.owner != program { return Err(ProgramError::IllegalOwner); }
    let data=account.try_borrow_data()?;
    if data.len()!=T::SPACE || data[..8]!=T::MAGIC { return Err(ProgramError::InvalidAccountData); }
    T::try_from_slice(&data[8..]).map_err(|_|ProgramError::InvalidAccountData)
}
pub fn save<T: State>(account: &AccountInfo, value: &T) -> Result<(),ProgramError> {
    if !account.is_writable { return Err(ProgramError::InvalidAccountData); }
    let mut data=account.try_borrow_mut_data()?;
    if data.len()!=T::SPACE { return Err(ProgramError::InvalidAccountData); }
    data[..8].copy_from_slice(&T::MAGIC);
    value.serialize(&mut &mut data[8..]).map_err(|_|ProgramError::InvalidAccountData)
}
