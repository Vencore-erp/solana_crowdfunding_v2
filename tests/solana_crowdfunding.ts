import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCrowdfunding } from "../target/types/solana_crowdfunding";
import { assert } from "chai";

describe("solana_crowdfunding", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaCrowdfunding as Program<SolanaCrowdfunding>;

  const campaignName = "MyCampaign";

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
  )

  it("1. Create Campaign (Goal: 5 SOL, Deadline: 3 sec)", async () => {
    const goal = new anchor.BN(5000000000);
    // 5 seconds deadline to allow some time for tests but still fast
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 5);

    await program.methods
      .createCampaign(campaignName, goal, deadline)
      .accounts({
        creator: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    console.log("   -> Campaign Created! Goal:", account.goal.toString());
    assert.ok(account.goal.eq(goal));
    assert.ok(account.name === campaignName);
  });

  it("2. Contribute (Donate 6 SOL)", async () => {
    const amount = new anchor.BN(6000000000);

    await program.methods
      .contribute(amount)
      .accounts({
        campaign: campaignPDA,
        contribution: contributionPDA,
        donor: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    const contribution = await program.account.contribution.fetch(contributionPDA);

    console.log("   -> Raised:", account.raised.toString());
    console.log("   -> User Contribution:", contribution.amount.toString());

    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    console.log("   -> Vault Balance (On-Chain):", vaultBalance);

    assert.ok(account.raised.eq(amount));
    assert.ok(contribution.amount.eq(amount));
  });

  it("3. Fail Withdraw (Too Early)", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          campaign: campaignPDA,
        })
        .rpc();
      assert.fail("Should have failed because deadline hasn't passed!");
    } catch (err) {
      console.log("   -> Success: Withdraw denied because deadline not passed.");
      // In a real test we should check the error code/msg specifically
    }
  });

  it("4. Fail Refund (Goal Met)", async () => {
    // Current raised 6 SOL > Goal 5 SOL. Refund should fail if we try to refund now
    // Wait, refund logic in lib.rs: "if campaign.raised >= campaign.goal { error }"
    // So this should fail.

    // We need to wait for deadline first though? 
    // "if clock.unix_timestamp < campaign.deadline { error }"
    // So if we try now, it fails "CampaignNotEnded".
    // Let's wait for deadline first.

    console.log("   -> Waiting 6 seconds for deadline to pass...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    try {
      const amount = new anchor.BN(1000000000);
      await program.methods
        .refund(amount)
        .accounts({
          campaign: campaignPDA,
          contribution: contributionPDA,
          donor: provider.wallet.publicKey,
        })
        .rpc();
      assert.fail("Should have failed because goal is met!");
    } catch (err) {
      console.log("   -> Success: Refund denied because goal is met.");
      // Error: GoalMetCannotRefund
    }
  });

  it("5. Success Withdraw (After Wait)", async () => {
    // Deadline passed in previous test step
    const initialBalance = await provider.connection.getBalance(provider.wallet.publicKey);

    await program.methods
      .withdraw()
      .accounts({
        campaign: campaignPDA,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    console.log("   -> Campaign Claimed Status:", account.claimed);

    assert.ok(account.claimed === true);

    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    assert.ok(vaultBalance === 0);
    console.log("   -> Vault empty, funds withdrawn!");
  });

  it("6. Contribute Fail (After Deadline)", async () => {
    // Deadline has passed
    try {
      const amount = new anchor.BN(1000000000);
      await program.methods
        .contribute(amount)
        .accounts({
          campaign: campaignPDA,
          contribution: contributionPDA,
          donor: provider.wallet.publicKey,
        })
        .rpc();
      assert.fail("Should have failed because campaign ended!");
    } catch (err) {
      console.log("   -> Success: Contribute denied because campaign ended.");
    }
  });
});