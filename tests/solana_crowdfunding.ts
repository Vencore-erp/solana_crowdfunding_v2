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
  );

  it("1. Create Campaign (Goal: 1000 SOL, Deadline: 5 sec)", async () => {
    const goal = new anchor.BN(1000 * 1e9); // 1000 SOL in lamports
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 5);

    await program.methods
      .createCampaign(campaignName, goal, deadline)
      .accounts({
        creator: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    assert.ok(account.goal.eq(goal));
    assert.ok(account.name === campaignName);
  });

  it("2. Contribute 600 SOL -> should succeed, raised=600", async () => {
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
    assert.ok(account.raised.eq(new anchor.BN(600 * 1e9)));
  });

  it("3. Contribute 500 SOL -> should succeed, raised=1100", async () => {
    const amount = new anchor.BN(500 * 1e9);

    await program.methods
      .contribute(amount)
      .accounts({
        campaign: campaignPDA,
        contribution: contributionPDA,
        donor: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    assert.ok(account.raised.eq(new anchor.BN(1100 * 1e9)));
  });

  it("4. Try withdraw before deadline -> should fail", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          campaign: campaignPDA,
        })
        .rpc();
      assert.fail("Should have failed because deadline hasn't passed!");
    } catch (err) {
      assert.include(err.toString(), "CampaignNotEnded");
    }
  });

  it("5. Wait until after deadline -> withdraw should succeed", async () => {
    console.log("   -> Waiting 6 seconds for deadline to pass...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    await program.methods
      .withdraw()
      .accounts({
        campaign: campaignPDA,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    assert.ok(account.claimed === true);

    // vault balance should be 0
    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    assert.ok(vaultBalance === 0);
  });

  it("6. Try withdraw again -> should fail (already claimed)", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          campaign: campaignPDA,
        })
        .rpc();
      assert.fail("Should have failed because already claimed!");
    } catch (err) {
      assert.include(err.toString(), "AlreadyClaimed");
    }
  });
});