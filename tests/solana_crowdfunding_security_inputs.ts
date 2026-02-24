import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCrowdfunding } from "../target/types/solana_crowdfunding";
import { assert } from "chai";

describe("solana_crowdfunding_security_inputs", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.SolanaCrowdfunding as Program<SolanaCrowdfunding>;

    it("1. Fail to create campaign with name > 32 bytes", async () => {
        // 33 characters long
        const longName = "ThisNameIsExactlyThirtyThreeBytes";
        const goal = new anchor.BN(1000 * 1e9);
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 1000); // far future

        try {
            await program.methods
                .createCampaign(longName, goal, deadline)
                .accounts({
                    creator: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because name is too long!");
        } catch (err) {
            assert.include(err.toString(), "NameTooLong");
        }
    });

    it("2. Fail to create campaign with 0 goal", async () => {
        const validName = "ValidName";
        const invalidGoal = new anchor.BN(0);
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 1000);

        try {
            await program.methods
                .createCampaign(validName, invalidGoal, deadline)
                .accounts({
                    creator: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because goal is 0!");
        } catch (err) {
            assert.include(err.toString(), "InvalidGoal");
        }
    });

    it("3. Fail to create campaign with past deadline", async () => {
        const validName = "ValidName";
        const goal = new anchor.BN(1000 * 1e9);
        // 10 seconds in the past
        const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 10);

        try {
            await program.methods
                .createCampaign(validName, goal, pastDeadline)
                .accounts({
                    creator: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because deadline is in the past!");
        } catch (err) {
            assert.include(err.toString(), "DeadlineInPast");
        }
    });

    it("4. Fail to contribute 0 amount", async () => {
        // Setup a valid campaign first
        const campaignName = "ZeroContribTest";
        const [campaignPDA] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("campaign"), provider.wallet.publicKey.toBuffer(), Buffer.from(campaignName)],
            program.programId
        );
        const [contributionPDA] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("contribution"), campaignPDA.toBuffer(), provider.wallet.publicKey.toBuffer()],
            program.programId
        );

        const goal = new anchor.BN(1000 * 1e9);
        const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 1000);

        await program.methods
            .createCampaign(campaignName, goal, deadline)
            .accounts({
                creator: provider.wallet.publicKey,
            })
            .rpc();

        // Now try to contribute 0
        try {
            const invalidAmount = new anchor.BN(0);
            await program.methods
                .contribute(invalidAmount)
                .accounts({
                    campaign: campaignPDA,
                    contribution: contributionPDA,
                    donor: provider.wallet.publicKey,
                })
                .rpc();
            assert.fail("Should have failed because amount is 0!");
        } catch (err) {
            assert.include(err.toString(), "InvalidAmount");
        }
    });
});
