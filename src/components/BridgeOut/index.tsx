"use client";

import "react-toastify/dist/ReactToastify.css";
import { useEffect, useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import {
  wagmiConfig,
  getContractAddress,
  isSupportedChain,
  getChainName,
  notifyBridgeOut,
} from "@/app/wagmi";
import { abi } from "../../utils/abis/Liberdus.json";
import { toast } from "react-toastify";
import { useAccount } from "wagmi";
import { colors } from "@/theme/colors";

// SVG Refresh Icon Component
const RefreshIcon = ({ size = 12, isLoading = false }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{
      display: "inline-block",
      animation: isLoading ? "spin 1s linear infinite" : "none",
      transition: "transform 0.2s ease",
    }}
  >
    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
  </svg>
);

function BridgeOut() {
  const { isConnected } = useAccount({
    config: wagmiConfig,
  });
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [amount, setAmount] = useState("0");
  const [balance, setBalance] = useState("0");
  const [chainId, setChainId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [amountError, setAmountError] = useState<string>("");
  const amountRef = useRef(amount);

  const isCurrentChainSupported = chainId ? isSupportedChain(chainId) : false;

  // Validate amount function
  const validateAmount = useCallback(
    (value: string) => {
      setAmountError("");

      if (!value || value === "0" || parseFloat(value) === 0) {
        setAmountError("Amount must be greater than 0");
        return false;
      }

      if (parseFloat(value) > parseFloat(balance)) {
        setAmountError("Amount exceeds balance");
        return false;
      }

      return true;
    },
    [balance]
  );

  // Debounced balance fetching function
  const fetchBalance = useCallback(async () => {
    if (
      !contract ||
      !signer?.address ||
      !chainId ||
      !isSupportedChain(chainId)
    ) {
      setBalance("0");
      setAmount("0");
      return;
    }

    setIsLoadingBalance(true);
    try {
      // Create a fresh contract instance to avoid stale network errors
      const contractAddress = getContractAddress(chainId);
      const freshProvider = new ethers.BrowserProvider(window.ethereum);
      const freshContract = new ethers.Contract(
        contractAddress,
        abi,
        freshProvider
      );

      const balance = await freshContract.balanceOf(signer.address);
      const formatted = ethers.formatEther(balance);
      setBalance(formatted);

      // Re-validate amount after balance update
      const currentAmount = amountRef.current;
      if (currentAmount && currentAmount !== "0") {
        if (parseFloat(currentAmount) > parseFloat(formatted)) {
          setAmountError("Amount exceeds balance");
        } else {
          setAmountError("");
        }
      }
    } catch (error: any) {
      console.error("Error getting balance:", error);
      setBalance("0");
      setAmount("0");
      // Don't show toast for network change errors
      if (!error?.message?.includes("network changed")) {
        toast.error("Failed to fetch balance");
      }
    } finally {
      setIsLoadingBalance(false);
    }
  }, [contract, signer?.address, chainId]);

  // Manual refresh balance function
  const refreshBalance = useCallback(async () => {
    if (!isLoadingBalance) {
      await fetchBalance();
      toast.success("Balance refreshed!");
    }
  }, [fetchBalance, isLoadingBalance]);

  // Initialize provider and check connection status on mount
  useEffect(() => {
    async function initializeProvider() {
      if (window.ethereum) {
        const provider = new ethers.BrowserProvider(window.ethereum);
        setProvider(provider);

        // Check if already connected
        try {
          const accounts = await window.ethereum.request({
            method: "eth_accounts",
          });
          if (accounts.length > 0) {
            // Already connected, get signer
            const signer = await provider.getSigner();
            setSigner(signer);
          }
        } catch (error) {
          console.error("Error checking connection status:", error);
        }

        // Get current network
        try {
          const network = await provider.getNetwork();
          setChainId(Number(network.chainId));
        } catch (error) {
          console.error("Error getting network:", error);
        }
      }
    }

    initializeProvider();
  }, []);

  // Update provider when connection status changes
  useEffect(() => {
    if (!isConnected) {
      setSigner(null);
      setBalance("0"); // Reset balance when disconnected
      setAmount("0");
      setAmountError("");
      return;
    }

    if (window.ethereum && !provider) {
      const newProvider = new ethers.BrowserProvider(window.ethereum);
      setProvider(newProvider);
    }
  }, [isConnected, provider]);

  useEffect(() => {
    async function getChainIdAndSetup() {
      if (!provider) return;

      try {
        const network = await provider.getNetwork();
        const newChainId = Number(network.chainId);
        console.log("network", network.chainId);

        // Reset balance when chain changes
        if (chainId !== null && chainId !== newChainId) {
          setBalance("0");
          setAmount("0");
          setAmountError("");
          setContract(null); // Clear old contract immediately
        }

        setChainId(newChainId);
      } catch (error) {
        // Ignore network change errors during transitions
        if (!error.message?.includes("network changed")) {
          console.error("Error getting network:", error);
        }
      }
    }

    getChainIdAndSetup();

    // Listen for network changes
    if (window.ethereum) {
      const handleChainChanged = async (newChainId: string) => {
        const chainIdNum = Number(newChainId);
        console.log("Chain changed to:", chainIdNum);

        // Reset state immediately
        setBalance("0");
        setAmount("0");
        setAmountError("");
        setContract(null);
        setChainId(chainIdNum);

        // Create new provider for the new network
        try {
          const newProvider = new ethers.BrowserProvider(window.ethereum);
          setProvider(newProvider);

          // Get new signer if connected
          if (isConnected) {
            const newSigner = await newProvider.getSigner();
            setSigner(newSigner);
          }
        } catch (error) {
          console.error(
            "Error setting up new provider after chain change:",
            error
          );
        }
      };

      const handleAccountsChanged = async (accounts: string[]) => {
        if (accounts.length === 0) {
          // User disconnected
          setSigner(null);
          setBalance("0");
          setAmount("0");
          setAmountError("");
        } else if (provider) {
          // User connected or switched accounts
          try {
            const signer = await provider.getSigner();
            setSigner(signer);
            // Balance will be fetched in the balance effect
          } catch (error) {
            console.error("Error getting signer after account change:", error);
          }
        }
      };

      window.ethereum.on("chainChanged", handleChainChanged);
      window.ethereum.on("accountsChanged", handleAccountsChanged);

      return () => {
        if (window.ethereum) {
          window.ethereum.removeListener("chainChanged", handleChainChanged);
          window.ethereum.removeListener(
            "accountsChanged",
            handleAccountsChanged
          );
        }
      };
    }
  }, [provider, chainId, isConnected]);

  // Update contract when chain changes
  useEffect(() => {
    if (provider && chainId && isSupportedChain(chainId)) {
      try {
        const contractAddress = getContractAddress(chainId);
        // Use a small delay to ensure provider is ready for the new network
        const timer = setTimeout(() => {
          const newContract = new ethers.Contract(
            contractAddress,
            abi,
            provider
          );
          setContract(newContract);
          console.log(
            "Contract updated for chain:",
            chainId,
            "address:",
            contractAddress
          );
        }, 100);

        return () => clearTimeout(timer);
      } catch (error) {
        console.error("Error creating contract:", error);
        setContract(null);
      }
    } else {
      setContract(null);
      setBalance("0"); // Reset balance when contract is not available
      setAmount("0");
      setAmountError("");
    }
  }, [provider, chainId]);

  // Fetch balance when contract or signer changes
  useEffect(() => {
    if (contract && signer?.address && isCurrentChainSupported) {
      console.log(
        "Fetching balance for address:",
        signer.address,
        "on chain:",
        chainId
      );
      // Add a small delay to ensure the contract is ready
      const timer = setTimeout(() => {
        fetchBalance();
      }, 200);

      return () => clearTimeout(timer);
    } else {
      setBalance("0");
      setAmount("0");
      setAmountError("");
    }
  }, [
    contract,
    signer?.address,
    isCurrentChainSupported,
    chainId,
    fetchBalance,
  ]);

  // Get signer when provider is available and user is connected
  useEffect(() => {
    async function getSigner() {
      if (provider && isConnected) {
        try {
          const signer = await provider.getSigner();
          setSigner(signer);
        } catch (error) {
          console.error("Error getting signer:", error);
        }
      }
    }

    getSigner();
  }, [provider, isConnected]);

  const connectWallet = async () => {
    if (window.ethereum) {
      try {
        // Request account access
        await window.ethereum.request({ method: "eth_requestAccounts" });

        const provider = new ethers.BrowserProvider(window.ethereum);
        setProvider(provider);

        const signer = await provider.getSigner();
        setSigner(signer);

        // Get network info
        const network = await provider.getNetwork();
        setChainId(Number(network.chainId));

        toast.success("Wallet connected successfully!");
      } catch (error) {
        console.error("Error connecting wallet:", error);
        toast.error("Failed to connect wallet");
      }
    } else {
      toast.error("MetaMask not found. Please install MetaMask.");
    }
  };

  const submitBridgeOut = async () => {
    if (!isCurrentChainSupported) {
      toast.error("Please switch to a supported network");
      return;
    }

    if (!validateAmount(amount)) {
      return;
    }

    setIsLoading(true);
    try {
      if (!contract || !signer) throw new Error("Contract or signer not ready");

      const contractWithSigner = contract.connect(signer) as any;
      const bridgeAmount = ethers.parseUnits(amount, 18);

      toast.info("Initiating bridge transaction...");

      const tx = await contractWithSigner.bridgeOut(
        bridgeAmount,
        signer.address,
        chainId
      );

      if (tx == null) {
        throw new Error("Transaction not submitted");
      }

      toast.info(
        `Transaction submitted: ${tx.hash}. Waiting for confirmation...`
      );

      // Wait for the transaction to be mined
      const receipt = await tx.wait();

      // Access the raw logs from the receipt
      const rawLogs = receipt.logs;
      const contractAddress = getContractAddress(chainId!);

      // Parse and decode the logs using the fresh contract interface
      const events = rawLogs
        // Filter logs emitted by your contract (optional but recommended)
        .filter(
          (log) => log.address.toLowerCase() === contractAddress.toLowerCase()
        )
        .map((log) => {
          try {
            // Parse the log to get the event object
            return contract.interface.parseLog(log);
          } catch (error) {
            // If the log is not from your contract's events, ignore it
            return null;
          }
        })
        // Remove any null entries resulting from failed parses
        .filter((event) => event !== null);

      // Now you have an array of decoded events
      console.log("Decoded Events:", events);

      // You can process the events as needed
      events.forEach((event) => {
        console.log(`Event ${event.name} emitted with args:`, event.args);
      });

      toast.success(`Bridge transaction completed! Hash: ${tx.hash}`);

      // Notify proxy (and optionally all observers) to poll BridgeOut immediately
      notifyBridgeOut(chainId, tx.hash).catch((err) =>
        console.warn("[notify-bridgeout] Failed to notify:", err)
      );

      // Refresh balance after successful transaction
      await fetchBalance();
      setAmount("0");
      setAmountError("");
    } catch (e: any) {
      console.error("Bridge transaction error:", e);

      // More specific error handling
      if (e.code === 4001) {
        toast.error("Transaction rejected by user");
      } else if (e.code === -32603) {
        toast.error("Internal JSON-RPC error. Please try again.");
      } else if (e.message?.includes("insufficient funds")) {
        toast.error("Insufficient funds for transaction");
      } else if (e.message?.includes("gas")) {
        toast.error("Gas estimation failed. Please try again.");
      } else {
        toast.error(e.message || "Transaction failed");
      }
    } finally {
      setIsLoading(false);
    }
  };

  function onAmountChange(e: any) {
    const value = e.target.value;
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      setAmount(value);
      amountRef.current = value;
      // Clear error when user starts typing
      if (amountError) {
        setAmountError("");
      }
      // Validate on change if value is not empty
      if (value && value !== "0") {
        validateAmount(value);
      }
    }
  }

  const formatAddress = (addr: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const setMaxAmount = () => {
    if (balance && parseFloat(balance) > 0) {
      setAmount(balance);
      amountRef.current = balance;
      setAmountError("");
    }
  };

  return (
    <div
      style={{
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        overflow: "hidden",
      }}
    >
      {/* Background decoration */}
      {/* <div
        style={{
          position: "absolute",
          top: "-10rem",
          right: "-10rem",
          width: "20rem",
          height: "20rem",
          background: "rgba(168, 85, 247, 0.1)",
          borderRadius: "50%",
          filter: "blur(60px)",
        }}
      ></div>
      <div
        style={{
          position: "absolute",
          bottom: "-10rem",
          left: "-10rem",
          width: "20rem",
          height: "20rem",
          background: "rgba(59, 130, 246, 0.1)",
          borderRadius: "50%",
          filter: "blur(60px)",
        }}
      ></div> */}

      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "28rem",
          margin: "5rem auto",
        }}
      >
        {/* Main Card */}
        <div
          style={{
            background: colors.background.card,
            border: `1px solid ${colors.border.subtle}`,
            borderRadius: "1.5rem",
            padding: "2rem",
            boxShadow: colors.shadows.card,
          }}
        >
          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: "2rem" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "4rem",
                height: "4rem",
                background: colors.gradients.purple,
                borderRadius: "1rem",
                marginBottom: "1rem",
                boxShadow: colors.shadows.buttonPurple,
                fontSize: "2rem",
                fontWeight: "bold",
              }}
            >
              ⟷
            </div>
            <h1
              style={{
                fontSize: "1.875rem",
                fontWeight: "bold",
                background: colors.gradients.purple,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                marginBottom: "0.5rem",
              }}
            >
              Bridge Out
            </h1>
            <p
              style={{
                color: colors.text.muted,
                fontSize: "0.875rem",
              }}
            >
              Convert Liberdus tokens to coins
            </p>
          </div>

          {/* Connection Status */}
          <div style={{ marginBottom: "1.5rem" }}>
            {isConnected || signer ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "1rem",
                  background: isCurrentChainSupported
                    ? "rgba(34, 197, 94, 0.1)"
                    : "rgba(239, 68, 68, 0.1)",
                  border: isCurrentChainSupported
                    ? "1px solid rgba(34, 197, 94, 0.2)"
                    : "1px solid rgba(239, 68, 68, 0.2)",
                  borderRadius: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <div
                    style={{
                      width: "1.25rem",
                      height: "1.25rem",
                      background: isCurrentChainSupported
                        ? "#22c55e"
                        : "#ef4444",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.7rem",
                      color: colors.text.primary,
                    }}
                  >
                    {isCurrentChainSupported ? "✓" : "!"}
                  </div>
                  <div>
                    <p
                      style={{
                        color: isCurrentChainSupported ? "#22c55e" : "#ef4444",
                        fontSize: "0.875rem",
                        fontWeight: "500",
                        margin: 0,
                      }}
                    >
                      {isCurrentChainSupported
                        ? "Ready to Bridge"
                        : "Network Not Supported"}
                    </p>
                    <p
                      style={{
                        color: colors.text.muted,
                        fontSize: "0.75rem",
                        margin: 0,
                      }}
                    >
                      {chainId ? getChainName(chainId) : "Unknown"} •{" "}
                      {formatAddress(signer?.address)}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div></div>
              // <div
              //   style={{
              //     display: "flex",
              //     alignItems: "center",
              //     justifyContent: "space-between",
              //     padding: "1rem",
              //     background: "rgba(251, 146, 60, 0.1)",
              //     border: "1px solid rgba(251, 146, 60, 0.2)",
              //     borderRadius: "0.75rem",
              //   }}
              // >
              //   <div
              //     style={{
              //       display: "flex",
              //       alignItems: "center",
              //       gap: "0.75rem",
              //     }}
              //   >
              //     <div
              //       style={{
              //         width: "1.25rem",
              //         height: "1.25rem",
              //         background: "#fb923c",
              //         borderRadius: "50%",
              //         display: "flex",
              //         alignItems: "center",
              //         justifyContent: "center",
              //         fontSize: "0.7rem",
              //         color: "white",
              //       }}
              //     >
              //       !
              //     </div>
              //     <p
              //       style={{
              //         color: "#fb923c",
              //         fontSize: "0.875rem",
              //         fontWeight: "500",
              //         margin: 0,
              //       }}
              //     >
              //       Supported Networks
              //     </p>
              //   </div>
              // </div>
            )}
          </div>

          {/* Form Fields - Only show if on supported network */}
          {isCurrentChainSupported && isConnected && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1.5rem",
              }}
            >
              {/* Target Address */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <label
                  style={{
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    color: colors.text.secondary,
                  }}
                >
                  Destination Address
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    name="target"
                    id="target"
                    placeholder="Target address"
                    value={signer?.address || ""}
                    disabled
                    style={{
                      width: "100%",
                      padding: "1rem",
                      background: colors.background.input,
                      border: `1px solid ${colors.border.subtle}`,
                      borderRadius: "0.75rem",
                      color: colors.text.primary,
                      fontSize: "0.875rem",
                      outline: "none",
                      opacity: signer?.address ? 1 : 0.6,
                      transition: "all 0.2s",
                    }}
                  />
                  {signer?.address && (
                    <div
                      style={{
                        position: "absolute",
                        right: "1rem",
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: "0.5rem",
                        height: "0.5rem",
                        background: "#22c55e",
                        borderRadius: "50%",
                        animation: "pulse 2s infinite",
                      }}
                    ></div>
                  )}
                </div>
              </div>

              {/* Amount */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <label
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: "500",
                      color: colors.text.secondary,
                    }}
                  >
                    Amount
                  </label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.875rem",
                      fontWeight: "500",
                      color: colors.text.secondary,
                    }}
                  >
                    <span>
                      Balance: {isLoadingBalance ? "Loading..." : balance}
                    </span>
                    {parseFloat(balance) > 0 && (
                      <>
                        <button
                          onClick={setMaxAmount}
                          style={{
                            background: colors.primary.bg,
                            border: `1px solid ${colors.primary.border}`,
                            borderRadius: "0.25rem",
                            padding: "0.25rem 0.5rem",
                            color: colors.primary.light,
                            fontSize: "0.75rem",
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background =
                              colors.primary.bgHover;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background =
                              colors.primary.bg;
                          }}
                        >
                          MAX
                        </button>
                        <button
                          onClick={refreshBalance}
                          disabled={isLoadingBalance}
                          title={
                            isLoadingBalance
                              ? "Refreshing balance..."
                              : "Refresh balance"
                          }
                          style={{
                            background: "rgba(34, 197, 94, 0.2)",
                            border: "1px solid rgba(34, 197, 94, 0.3)",
                            borderRadius: "0.25rem",
                            padding: "0.25rem 0.5rem",
                            color: "#22c55e",
                            fontSize: "0.75rem",
                            cursor: isLoadingBalance
                              ? "not-allowed"
                              : "pointer",
                            transition: "all 0.2s",
                            opacity: isLoadingBalance ? 0.6 : 1,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: "2rem",
                          }}
                          onMouseEnter={(e) => {
                            if (!isLoadingBalance) {
                              e.currentTarget.style.background =
                                "rgba(34, 197, 94, 0.3)";
                              e.currentTarget.style.transform = "scale(1.05)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isLoadingBalance) {
                              e.currentTarget.style.background =
                                "rgba(34, 197, 94, 0.2)";
                              e.currentTarget.style.transform = "scale(1)";
                            }
                          }}
                        >
                          <RefreshIcon size={12} isLoading={isLoadingBalance} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    name="amount"
                    id="amount"
                    placeholder="Amount"
                    value={amount}
                    onChange={onAmountChange}
                    style={{
                      width: "100%",
                      padding: "1rem",
                      background: "rgba(255, 255, 255, 0.05)",
                      border: amountError
                        ? "1px solid rgba(239, 68, 68, 0.5)"
                        : "1px solid rgba(255, 255, 255, 0.1)",
                      borderRadius: "0.75rem",
                      color: colors.text.primary,
                      fontSize: "1.25rem",
                      fontWeight: "600",
                      outline: "none",
                      transition: "all 0.2s",
                    }}
                    onFocus={(e) => {
                      if (!amountError) {
                        e.target.style.borderColor = colors.border.focus;
                        e.target.style.boxShadow =
                          `0 0 0 3px ${colors.border.focusRing}`;
                      }
                    }}
                    onBlur={(e) => {
                      if (!amountError) {
                        e.target.style.borderColor = colors.border.subtle;
                        e.target.style.boxShadow = "none";
                      }
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      right: "1rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: colors.text.muted,
                      fontWeight: "600",
                    }}
                  >
                    LIB
                  </div>
                </div>
                {/* Error message */}
                {amountError && (
                  <p
                    style={{
                      color: "#ef4444",
                      fontSize: "0.875rem",
                      margin: 0,
                      paddingLeft: "0.5rem",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.25rem",
                    }}
                  >
                    {/* <span>⚠️</span> */}
                    {amountError}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            onClick={!isConnected && !signer ? connectWallet : submitBridgeOut}
            disabled={
              isLoading ||
              isLoadingBalance ||
              ((isConnected || signer) &&
                (amount === "0" || !amount || !!amountError)) ||
              ((isConnected || signer) && (balance === "0" || !balance))
            }
            style={{
              width: "100%",
              marginTop: isConnected || signer ? "2rem" : "0rem",
              padding: "1rem",
              background:
                (isConnected || signer) && !isCurrentChainSupported
                  ? colors.gradients.error
                  : colors.gradients.purple,
              color: colors.text.inverse,
              fontWeight: "600",
              fontSize: "1rem",
              borderRadius: "0.75rem",
              border: "none",
              cursor:
                isLoading ||
                isLoadingBalance ||
                ((isConnected || signer) &&
                  (amount === "0" || !amount || amountError)) ||
                ((isConnected || signer) && (balance === "0" || !balance))
                  ? "not-allowed"
                  : "pointer",
              transition: "all 0.2s",
              transform: "scale(1)",
              boxShadow:
                isLoading ||
                isLoadingBalance ||
                ((isConnected || signer) &&
                  (amount === "0" || !amount || amountError)) ||
                ((isConnected || signer) && (balance === "0" || !balance))
                  ? "none"
                  : (isConnected || signer) && !isCurrentChainSupported
                  ? "0 10px 25px rgba(220, 38, 38, 0.3)"
                  : colors.shadows.buttonPurple,
              opacity:
                isLoading ||
                isLoadingBalance ||
                ((isConnected || signer) &&
                  (amount === "0" || !amount || amountError)) ||
                ((isConnected || signer) && (balance === "0" || !balance))
                  ? 0.6
                  : 1,
            }}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.transform = "scale(1.02)";
                e.currentTarget.style.background =
                  (isConnected || signer) && !isCurrentChainSupported
                    ? colors.gradients.errorHover
                    : colors.gradients.purpleHover;
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.transform = "scale(1)";
                e.currentTarget.style.background =
                  (isConnected || signer) && !isCurrentChainSupported
                    ? colors.gradients.error
                    : colors.gradients.purple;
              }
            }}
            onMouseDown={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.transform = "scale(0.98)";
              }
            }}
            onMouseUp={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.transform = "scale(1.02)";
              }
            }}
          >
            {isLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                }}
              >
                <div
                  style={{
                    width: "1.25rem",
                    height: "1.25rem",
                    border: "2px solid rgba(255, 255, 255, 0.3)",
                    borderTop: "2px solid white",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                  }}
                ></div>
                <span>Processing...</span>
              </div>
            ) : isLoadingBalance ? (
              "Loading Balance..."
            ) : !isConnected && !signer ? (
              "Connect Wallet"
            ) : !isCurrentChainSupported ? (
              "Switch to Supported Network"
            ) : (
              "Bridge Tokens"
            )}
          </button>

          {/* Footer Info */}
          <div style={{ marginTop: "1.5rem", textAlign: "center" }}>
            <p
              style={{
                fontSize: "0.75rem",
                color: colors.text.muted,
                marginBottom: "0.5rem",
              }}
            >
              Transaction typically completes in 2-5 minutes
            </p>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "1rem",
                fontSize: "0.75rem",
                color: colors.text.muted,
              }}
            >
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: colors.text.muted,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = colors.primary.main)}
                onMouseLeave={(e) => (e.currentTarget.style.color = colors.text.muted)}
              >
                <span>View on Explorer</span>
                <span>↗</span>
              </button>
              <span>•</span>
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: colors.text.muted,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = colors.primary.main)}
                onMouseLeave={(e) => (e.currentTarget.style.color = colors.text.muted)}
              >
                <span>Learn more</span>
                <span>↗</span>
              </button>
            </div>
          </div>
        </div>

        {/* Decorative Elements */}
        <div
          style={{
            position: "absolute",
            top: "-0.5rem",
            left: "-0.5rem",
            width: "1rem",
            height: "1rem",
            background: colors.decorative.dotLeft,
            borderRadius: "50%",
            animation: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            bottom: "-0.5rem",
            right: "-0.5rem",
            width: "1rem",
            height: "1rem",
            background: colors.decorative.dotRight,
            borderRadius: "50%",
            animation: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite",
            animationDelay: "1s",
          }}
        ></div>
      </div>

      <style jsx>{`
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
        @keyframes ping {
          75%,
          100% {
            transform: scale(2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}

export { BridgeOut };
