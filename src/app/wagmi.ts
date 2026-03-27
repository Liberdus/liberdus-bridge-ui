import { getDefaultConfig } from "@rainbow-me/rainbowkit";

import {
  mainnet,
  polygon,
  polygonAmoy,
  polygonMumbai,
  sepolia,
  bsc,
  bscTestnet,
} from "wagmi/chains";

// Network configuration with all chain details
export const networkConfig = {
  coordinatorUrl: "http://127.0.0.1:8000",
  /** Liberdus proxy URL (e.g. port 3030) – used for observer endpoints */
  liberdusProxyUrl: "http://127.0.0.1:3030",
  /**
   * When true, the UI will POST /notify-bridgeout directly to every observer URL
   * (observer-only mode; proxy is skipped).
   */
  notifyObserverDirectly: false,
  /**
   * Observer base URLs (observer listens on 8100 + PARTY_INDEX).
   * Default assumes 5 parties locally.
   */
  observerUrls: [
    "http://172.22.82.166:8101",
    "http://172.22.82.166:8102",
    "http://172.22.82.166:8103",
    "http://172.22.82.166:8104",
    "http://172.22.82.166:8105",
  ],
  vaultChain: {
    name: "Polygon Amoy Testnet",
    chainId: 80002,
    rpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com",
    contractAddress: "0xf563937Bc07cEFE9Cf028956EDF575234d8303ED",
    deploymentBlock: 35355000,
  },
  secondaryChainConfig: {
    name: "BSC Testnet",
    chainId: 97,
    rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    contractAddress: "0x4113aED4Cb0930A7DFD76c8fF694Be7c669b50f1",
    tssSenderAddress: "0xb1325c98Bc338986B64355cD72deC0E5eEa22416",
    bridgeAddress:
      "b1325c98bc338986b64355cd72dec0e5eea22416000000000000000000000000",
    gasConfig: {
      gasLimit: 200000,
      gasPriceTiers: [5, 10, 15, 20, 25, 30],
    },
    deploymentBlock: 96441497,
  },
  supportedChains: {
    "80002": {
      name: "Polygon Amoy Testnet",
      chainId: 80002,
      rpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com",
      contractAddress: "0xD5409531c857AfD1b2fF6Cd527038e9981ef4863",
      tssSenderAddress: "0x35576352AABCBCe19AeCE1fFD376f7C49F022706",
      bridgeAddress:
        "35576352aabcbce19aece1ffd376f7c49f022706000000000000000000000000",
      gasConfig: {
        gasLimit: 200000,
        gasPriceTiers: [50, 100, 150, 200, 250, 300],
      },
      deploymentBlock: 34134604,
    },
    "97": {
      name: "BSC Testnet",
      chainId: 97,
      rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
      contractAddress: "0x4113aED4Cb0930A7DFD76c8fF694Be7c669b50f1",
      tssSenderAddress: "0xb1325c98Bc338986B64355cD72deC0E5eEa22416",
      bridgeAddress:
        "b1325c98bc338986b64355cd72dec0e5eea22416000000000000000000000000",
      gasConfig: {
        gasLimit: 200000,
        gasPriceTiers: [5, 10, 15, 20, 25, 30],
      },
      deploymentBlock: 96441497,
    },
  },
  defaultChain: 80002,
  enableLiberdusNetwork: false,
  liberdusNetworkId:
    "7440f5161ffc77eed9ee91d6fbb406083192d1fe4d7e64b2f0814c0e067dcab4",
};

// Explorer URL mapping based on chain ID
export const getExplorerUrl = (chainId: number, txHash: string): string => {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io/tx/", // Ethereum Mainnet
    11155111: "https://sepolia.etherscan.io/tx/", // Ethereum Sepolia
    137: "https://polygonscan.com/tx/", // Polygon Mainnet
    80001: "https://mumbai.polygonscan.com/tx/", // Polygon Mumbai (deprecated)
    80002: "https://amoy.polygonscan.com/tx/", // Polygon Amoy
    56: "https://bscscan.com/tx/", // BSC Mainnet
    97: "https://testnet.bscscan.com/tx/", // BSC Testnet
    31337: "http://127.0.0.1:8545/tx/", // Local development
  };

  // Default to Liberdus explorer if chain ID not found in the EVM explorer map
  const explorerUrl = explorers[chainId];
  if (!explorerUrl) {
    return `${liberdusExplorer}${txHash}`;
  }

  // Ensure the hash has the 0x prefix required by EVM explorers
  const prefixedHash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  return `${explorerUrl}${prefixedHash}`;
};

// Helper function to get contract address for current chain
export const getContractAddress = (chainId: number): string => {
  const config = networkConfig.supportedChains[chainId.toString()];
  return (
    config?.contractAddress ||
    networkConfig.supportedChains["80002"].contractAddress
  );
};

// Helper function to check if chain is supported
export const isSupportedChain = (chainId: number): boolean => {
  if (!chainId) return false;
  return chainId.toString() in networkConfig.supportedChains;
};

// Helper function to get all supported chain IDs
export const getSupportedChainIds = (): number[] => {
  return Object.keys(networkConfig.supportedChains).map((id) => parseInt(id));
};

// Helper function to get chain name
export const getChainName = (chainId: number): string => {
  if (!chainId) return "Unsupported Network";
  const config = networkConfig.supportedChains[chainId.toString()];
  return config?.name || "Unsupported Network";
};

// Helper function to check if chain supports destination chain ID in bridgeOut
export const supportsBridgeChainId = (chainId: number): boolean => {
  if (!chainId) return false;
  const config = networkConfig.supportedChains[chainId.toString()];
  return config?.supportsBridgeChainId ?? false;
};

// Helper function to check if chain uses vault contract for bridging
// When enableLiberdusNetwork is false, the vaultChain is used for bridging
export const isVaultChain = (chainId: number): boolean => {
  if (!chainId) return false;
  return (
    !networkConfig.enableLiberdusNetwork &&
    networkConfig.vaultChain.chainId === chainId
  );
};

// Helper function to get vault contract address for a chain (null if not the vault chain)
export const getVaultContractAddress = (chainId: number): string | null => {
  if (!chainId) return null;
  if (
    !networkConfig.enableLiberdusNetwork &&
    networkConfig.vaultChain.chainId === chainId
  ) {
    return networkConfig.vaultChain.contractAddress;
  }
  return null;
};

// Helper function to check if Liberdus Network is enabled as bridge destination
export const isLiberdusNetworkEnabled = (): boolean => {
  return networkConfig.enableLiberdusNetwork;
};

// Liberdus network chain ID (matches DEFAULT_CHAIN_ID in the token contract)
export const LIBERDUS_CHAIN_ID = 0;

// Add enum for mode
export enum Mode {
  Development = "development",
  Production = "production",
}

const mode = process.env.NEXT_PUBLIC_MODE || Mode.Development;
export const wagmiConfig = getDefaultConfig({
  appName: "Liberdus Token Bridge",
  projectId: "a456240005ff39a4d2dc51d18ffa4ad9",
  chains:
    mode === Mode.Production
      ? [mainnet, polygon, polygonMumbai, bsc]
      : [sepolia, polygonAmoy, bscTestnet],
  ssr: true, // If your dApp uses server side rendering (SSR)
});

// Legacy exports for backward compatibility
export const bridgeInUsername = "liberdusbridge";
export const liberdusExplorer = "https://dev.liberdus.com:3035/tx/";
