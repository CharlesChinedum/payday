//! Testnet-only stand-in for USDC: a standard NEP-141 token (6 decimals) with a public
//! `mint`, so anyone trying Payday can fund payroll without a faucet.
//! Never deploy this to mainnet.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// 10,000 USDC per mint call.
pub const MAX_MINT: u128 = 10_000 * 1_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new() -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: FungibleTokenMetadata {
                spec: FT_METADATA_SPEC.to_string(),
                name: "Mock USDC (testnet)".to_string(),
                symbol: "USDC".to_string(),
                icon: None,
                reference: None,
                reference_hash: None,
                decimals: 6,
            },
        }
    }

    /// Mints up to `MAX_MINT` to `account_id`, registering it if needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            amount.0 > 0 && amount.0 <= MAX_MINT,
            "Mint between 1 unit and 10,000 USDC"
        );
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("testnet mint"),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        U128(used)
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    #[test]
    fn mint_registers_and_credits() {
        testing_env!(VMContextBuilder::new().build());
        let mut c = MockUsdc::new();
        let alice: AccountId = "alice.testnet".parse().unwrap();
        c.mint(alice.clone(), U128(5_000_000));
        assert_eq!(c.ft_balance_of(alice.clone()).0, 5_000_000);
        assert_eq!(c.ft_total_supply().0, 5_000_000);
        assert!(c.storage_balance_of(alice).is_some());
    }

    #[test]
    #[should_panic(expected = "Mint between 1 unit and 10,000 USDC")]
    fn mint_is_capped() {
        testing_env!(VMContextBuilder::new().build());
        MockUsdc::new().mint("alice.testnet".parse().unwrap(), U128(MAX_MINT + 1));
    }
}
