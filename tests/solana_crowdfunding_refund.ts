import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCrowdfunding } from "../target/types/solana_crowdfunding";
import { assert } from "chai";

describe("solana_crowdfunding_refund_security", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.SolanaCrowdfunding as Program<SolanaCrowdfunding>;

    // Use a different campaign name to avoid account collisions with the other test
    const campaignName = "RefundTest";

    const [campaignPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("campaign"),
            provider.wallet.publicKey.toBuffer(),
            Buffer.from(campaignName)
        ],
        program.programId
    );

    const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), campaignPDA.toBuffer()],
        program.programId
    );

    const [contributionPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("contribution"),
            campaignPDA.toBuffer(),
            provider.wallet.publicKey.toBuffer()
        ],
        program.programId
    );

    it("1. Create Campaign (Goal: 1000 SOL, Deadline: 5 sec)", async () => {
        const goal = new anchor.BN(1000 * 1e9);
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 5);

        await program.methods
            .createCampaign(campaignName, goal, deadline)
            .accounts({
                creator: provider.wallet.publicKey,
            })
            .rpc();

        const account = await program.account.campaign.fetch(campaignPDA);
        assert.ok(account.goal.eq(goal));
    });

    it("2. Contribute 600 SOL -> should succeed, raised=600", async () => {
        // We only contribute 600 so it fails the 1000 goal
        const amount = new anchor.BN(600 * 1e9);

        await program.methods
            .contribute(amount)
            .accounts({
                campaign: campaignPDA,
                contribution: contributionPDA,
                donor: provider.wallet.publicKey,
            })
            .rpc();

        const account = await program.account.campaign.fetch(campaignPDA);
        assert.ok(account.raised.eq(amount));
    });

    it("3. Try refund before deadline -> should fail", async () => {
        try {
            await program.methods
                .refund()
                .accounts({
                    campaign: campaignPDA,
                    contribution: contributionPDA,
                    donor: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because campaign has not ended!");
        } catch (err) {
            assert.include(err.toString(), "CampaignNotEnded");
        }
    });

    it("4. Wait until after deadline to fail the campaign", async () => {
        console.log("   -> Waiting 6 seconds for deadline to pass...");
        await new Promise((resolve) => setTimeout(resolve, 6000));
        // Verify time passed
        assert.ok(true);
    });

    it("5. Simulate Rent-Exemption Grief Attack (sending 1 lamport to vault)", async () => {
        // Attacker manually sends 1 lamport to the vault
        const tx = new anchor.web3.Transaction().add(
            anchor.web3.SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: vaultPDA,
                lamports: 1, // Dust 
            })
        );
        await provider.sendAndConfirm(tx);

        // Check it's there
        const vaultBalance = await provider.connection.getBalance(vaultPDA);
        // 600 SOL (600,000,000,000 lamports) + vault rent exemption + 1 extra dust lamport
        console.log("   -> Vault Balance before refund (with dust):", vaultBalance);
        assert.ok(vaultBalance > 600 * 1e9);
    });

    it("6. Execute Refund -> should succeed despite the grief attack and clear the vault", async () => {
        const initialBalance = await provider.connection.getBalance(provider.wallet.publicKey);

        // This is the true fix: The refund will sweep the dust because raised == amount (last donor)
        await program.methods
            .refund()
            .accounts({
                campaign: campaignPDA,
                contribution: contributionPDA,
                donor: provider.wallet.publicKey,
            })
            .rpc();

        // Check contribution PDA is closed
        const contributionAccountInfo = await provider.connection.getAccountInfo(contributionPDA);
        assert.isNull(contributionAccountInfo, "Contribution PDA should be closed");

        // Check vault is 0
        const vaultBalance = await provider.connection.getBalance(vaultPDA);
        console.log("   -> Vault Balance after refund:", vaultBalance);
        assert.ok(vaultBalance === 0, "Vault should be completely empty");

        const campaignAccount = await program.account.campaign.fetch(campaignPDA);
        assert.ok(campaignAccount.raised.eq(new anchor.BN(0)), "Raised should be 0");
    });

    it("7. Try refunding again -> should fail (contribution account missing)", async () => {
        try {
            await program.methods
                .refund() // no amount parameter passed, IDL doesn't even allow it
                .accounts({
                    campaign: campaignPDA,
                    contribution: contributionPDA, // This is now closed
                    donor: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because contribution PDA is closed!");
        } catch (err) {
            // The error should be that the account doesn't exist
            assert.include(err.toString(), "AccountNotInitialized");
        }
    });

    it("8. Hacker tries to refund from a campaign without ever contributing (Drain attempt)", async () => {
        // Generate a brand new fresh keypair that has never contributed
        const hacker = anchor.web3.Keypair.generate();

        // Airdrop some SOL to the hacker so they can pay for transaction fees
        const airdropTx = await provider.connection.requestAirdrop(hacker.publicKey, 1000000 * 1e9);
        const latestBlockHash = await provider.connection.getLatestBlockhash();
        await provider.connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: airdropTx
        });

        // The hacker has to derive what THEIR contribution PDA would be
        const [hackerContributionPDA] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("contribution"), campaignPDA.toBuffer(), hacker.publicKey.toBuffer()],
            program.programId
        );

        try {
            await program.methods
                .refund()
                .accounts({
                    campaign: campaignPDA,
                    contribution: hackerContributionPDA, // Hacker tries to submit their own empty PDA
                    donor: hacker.publicKey,
                })
                .signers([hacker]) // Hacker signs
                .rpc();
            assert.fail("Hacker drain attempt should have failed!");
        } catch (err) {
            // Fails because their PDA was never initialized (they never contributed)
            assert.include(err.toString(), "AccountNotInitialized");
        }
    });
});
