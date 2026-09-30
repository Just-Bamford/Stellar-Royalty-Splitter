const hre = require("hardhat");

async function main() {
  console.log("Deploying RoyaltySplitter to Ethereum...");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const RoyaltySplitter = await hre.ethers.getContractFactory("RoyaltySplitter");
  const royaltySplitter = await RoyaltySplitter.deploy();

  await royaltySplitter.waitForDeployment();
  const address = await royaltySplitter.getAddress();

  console.log("RoyaltySplitter deployed to:", address);

  // Initialize with default collaborators (adjust as needed)
  const collaborators = [deployer.address];
  const shares = [10000]; // 100% to deployer initially
  const royaltyRate = 1000; // 10% royalty rate

  const tx = await royaltySplitter.initialize(collaborators, shares, royaltyRate);
  await tx.wait();

  console.log("Contract initialized with royalty rate:", royaltyRate);

  // Verify contract on Etherscan (if API key is configured)
  if (process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting for block confirmations...");
    await royaltySplitter.deploymentTransaction().wait(5);
    
    try {
      await hre.run("verify:verify", {
        address: address,
        constructorArguments: []
      });
      console.log("Contract verified on Etherscan");
    } catch (error) {
      console.log("Verification failed:", error.message);
    }
  }

  console.log("\nDeployment complete!");
  console.log("Contract address:", address);
  console.log("Network:", hre.network.name);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
