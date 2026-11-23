#![allow(deprecated)]
pub mod state;
pub mod processor;
pub mod validation;

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

#[cfg(not(feature="no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    processor::process(program,accounts,data)
}
