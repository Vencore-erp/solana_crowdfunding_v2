use anchor_lang::prelude::*;
use anchor_lang::system_program;


declare_id!("5fwXYYbWEJaTQ2LWeMaWm6NWQAsQjKqBRuWHe4g8EY9f");

#[program]
pub mod solana_crowdfunding {
    use super::*;


    pub fn create_campaign(ctx: Context<Create>, goal: u64, deadline: i64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let clock = Clock::get()?;


        if deadline <= clock.unix_timestamp {
            return err!(CrowdfundError::DeadlineInPast);
        }

        campaign.creator = *ctx.accounts.creator.key;
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
        

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.donor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        campaign.raised += amount;
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
        if campaign.claimed {
            return err!(CrowdfundError::AlreadyClaimed);
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

        campaign.claimed = true;
        msg!("Withdrawn all funds: {} lamports", vault_balance);
        Ok(())
    }


    pub fn refund(ctx: Context<Refund>, amount: u64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let donor = &mut ctx.accounts.donor;
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;


        if clock.unix_timestamp < campaign.deadline {
            return err!(CrowdfundError::CampaignNotEnded);
        }
        if campaign.raised >= campaign.goal {
            return err!(CrowdfundError::GoalMetCannotRefund);
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

        msg!("Refunded: {} lamports", amount);
        Ok(())
    }
}



#[derive(Accounts)]
pub struct Create<'info> {
    #[account(
        init, 
        payer = creator, 
        space = 8 + 32 + 8 + 8 + 8 + 1 + 1,
        seeds = [b"campaign", creator.key().as_ref()], 
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
    pub goal: u64,
    pub raised: u64,
    pub deadline: i64,
    pub claimed: bool,
    pub bump: u8,
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
}