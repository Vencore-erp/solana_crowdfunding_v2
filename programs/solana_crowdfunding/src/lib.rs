use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("5fwXYYbWEJaTQ2LWeMaWm6NWQAsQjKqBRuWHe4g8EY9f");

#[program]
pub mod solana_crowdfunding {
    use super::*;

    pub fn create_campaign(ctx: Context<Create>, name: String, goal: u64, deadline: i64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let clock = Clock::get()?;

        if deadline <= clock.unix_timestamp {
            return err!(CrowdfundError::DeadlineInPast);
        }

        campaign.creator = *ctx.accounts.creator.key;
        campaign.name = name;
        campaign.goal = goal;
        campaign.raised = 0;
        campaign.deadline = deadline;
        campaign.claimed = false;
        campaign.bump = ctx.bumps.campaign;

        msg!("Campaign created! Goal: {} lamports, Deadline: {}", goal, deadline);
        Ok(())
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let contribution = &mut ctx.accounts.contribution;
        let clock = Clock::get()?;

        if clock.unix_timestamp >= campaign.deadline {
            return err!(CrowdfundError::CampaignEnded);
        }

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.donor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        campaign.raised = campaign.raised.checked_add(amount).ok_or(CrowdfundError::Overflow)?;
        contribution.amount = contribution.amount.checked_add(amount).ok_or(CrowdfundError::Overflow)?;
        
        msg!("Contributed: {} lamports. Total Raised: {}", amount, campaign.raised);
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let creator = &mut ctx.accounts.creator;
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        if campaign.raised < campaign.goal {
            return err!(CrowdfundError::GoalNotMet);
        }
        if clock.unix_timestamp < campaign.deadline {
            return err!(CrowdfundError::CampaignNotEnded);
        }

        let vault_balance = vault.lamports();

        let campaign_key = campaign.key();
        let seeds = &[
            b"vault",
            campaign_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: vault.to_account_info(),
                to: creator.to_account_info(),
            },
            signer_seeds,
        );
        
        system_program::transfer(cpi_context, vault_balance)?;

        msg!("Withdrawn all funds: {} lamports. Campaign closed.", vault_balance);
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, amount: u64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let contribution = &mut ctx.accounts.contribution;
        let donor = &mut ctx.accounts.donor;
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        // Refund allows if campaign failed (deadline passed AND goal not met)
        if clock.unix_timestamp < campaign.deadline {
            return err!(CrowdfundError::CampaignNotEnded);
        }
        if campaign.raised >= campaign.goal {
            return err!(CrowdfundError::GoalMetCannotRefund);
        }
        
        if contribution.amount < amount {
            return err!(CrowdfundError::InsufficientContribution);
        }

        let campaign_key = campaign.key();
        let seeds = &[
            b"vault",
            campaign_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: vault.to_account_info(),
                to: donor.to_account_info(),
            },
            signer_seeds,
        );

        system_program::transfer(cpi_context, amount)?;

        campaign.raised = campaign.raised.checked_sub(amount).ok_or(CrowdfundError::Overflow)?;
        contribution.amount = contribution.amount.checked_sub(amount).ok_or(CrowdfundError::Overflow)?;

        if contribution.amount == 0 {
            ctx.accounts.contribution.close(donor.to_account_info())?;
        }

        msg!("Refunded: {} lamports", amount);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(name: String, goal: u64, deadline: i64)]
pub struct Create<'info> {
    #[account(
        init, 
        payer = creator, 
        // Space calculation:
        // 8 discriminator
        // 32 creator pubkey
        // 4 + name.len() string
        // 8 goal
        // 8 raised
        // 8 deadline
        // 1 claimed
        // 1 bump
        space = 8 + 32 + (4 + name.len()) + 8 + 8 + 8 + 1 + 1,
        seeds = [b"campaign", creator.key().as_ref(), name.as_bytes()], 
        bump
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init_if_needed,
        payer = donor,
        space = 8 + 8, // Discriminator + amount
        seeds = [b"contribution", campaign.key().as_ref(), donor.key().as_ref()],
        bump
    )]
    pub contribution: Account<'info, Contribution>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub donor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        close = creator,
        has_one = creator @ CrowdfundError::NotCreator
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [b"contribution", campaign.key().as_ref(), donor.key().as_ref()],
        bump
    )]
    pub contribution: Account<'info, Contribution>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub donor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Campaign {
    pub creator: Pubkey,
    pub name: String,
    pub goal: u64,
    pub raised: u64,
    pub deadline: i64,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
pub struct Contribution {
    pub amount: u64,
}

#[error_code]
pub enum CrowdfundError {
    #[msg("Deadline must be in the future.")]
    DeadlineInPast,
    #[msg("Goal not met.")]
    GoalNotMet,
    #[msg("Campaign has not ended yet.")]
    CampaignNotEnded,
    #[msg("Funds already claimed.")]
    AlreadyClaimed,
    #[msg("Not the creator.")]
    NotCreator,
    #[msg("Goal met, cannot refund.")]
    GoalMetCannotRefund,
    #[msg("Campaign has ended.")]
    CampaignEnded,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Insufficient contribution amount.")]
    InsufficientContribution,
}