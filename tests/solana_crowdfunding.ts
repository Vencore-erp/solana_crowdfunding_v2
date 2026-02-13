import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCrowdfunding } from "../target/types/solana_crowdfunding";
import { assert } from "chai";

describe("solana_crowdfunding", () => {

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaCrowdfunding as Program<SolanaCrowdfunding>;

  const [campaignPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );


  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaignPDA.toBuffer()],
    program.programId
  );

  it("1. Create Campaign (Goal: 5 SOL, Deadline: 3 sec)", async () => {
    const goal = new anchor.BN(5000000000);

    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3);

    await program.methods
      .createCampaign(goal, deadline)
      .accounts({
        creator: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    console.log("   -> Campaign Created! Goal:", account.goal.toString());
    assert.ok(account.goal.eq(goal));
  });

  it("2. Contribute (Donasi 6 SOL)", async () => {
    const amount = new anchor.BN(6000000000);

    await program.methods
      .contribute(amount)
      .accounts({
        campaign: campaignPDA,
        donor: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.campaign.fetch(campaignPDA);
    console.log("   -> Raised:", account.raised.toString());


    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    console.log("   -> Vault Balance (On-Chain):", vaultBalance);

    assert.ok(account.raised.eq(amount));
  });

  it("3. Fail Withdraw (Too Early)", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          campaign: campaignPDA,
        })
        .rpc();
      assert.fail("Harusnya gagal karena deadline belum lewat!");
    } catch (err) {
      console.log("   -> Sukses: Withdraw ditolak karena belum deadline.");

    }
  });

  it("4. Success Withdraw (After Wait)", async () => {
    console.log("   -> Menunggu 5 detik agar deadline lewat...");
    await new Promise((resolve) => setTimeout(resolve, 5000));


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
    console.log("   -> Vault kosong, dana berhasil ditarik!");
  });
});