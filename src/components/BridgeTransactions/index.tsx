"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { networkConfig, getChainName, getExplorerUrl, LIBERDUS_CHAIN_ID } from "@/app/wagmi";
import { ethers } from "ethers";
import { toEthereumAddress } from "@/utils/transformAddress";
import moment from "moment";
import { colors } from "@/theme/colors";

export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: TransactionType;
  txTimestamp: number;                // Source bridge tx timestamp (ms)
  chainId: number;
  status: TransactionStatus;
  receiptId: string;
  tssSender?: string | null;          // TSS sender address used for this tx
  nonce?: number | null;              // EVM tssSender account nonce from the on-chain receipt; null for Liberdus txs
  receiptTimestamp?: number | null;   // Liberdus tssSender receipt timestamp (ms); null for EVM txs
  reason?: string | null;             // Reason for failure
  executionHistory?: string | null;   // JSON: tracks failed/incompleted tx attempts
  createdAt?: number;
  updatedAt?: number;
}

export interface ExecutionHistoryEntry {
  status: TransactionStatus;
  receiptId?: string;
  reason?: string;
}

// Derive source chain ID from transaction type:
//   BRIDGE_IN:    Liberdus → tx.chainId
//   BRIDGE_OUT:   tx.chainId → Liberdus
//   BRIDGE_VAULT: tx.chainId (vault) → secondaryChainConfig
function getSourceChainId(tx: Transaction): number {
  if (tx.type === TransactionType.BRIDGE_IN) return LIBERDUS_CHAIN_ID;
  return tx.chainId;
}

function getDestChainId(tx: Transaction): number {
  if (tx.type === TransactionType.BRIDGE_IN) return tx.chainId;
  if (tx.type === TransactionType.BRIDGE_VAULT) return networkConfig.secondaryChainConfig.chainId;
  return LIBERDUS_CHAIN_ID; // BRIDGE_OUT
}

function getReceiptChainId(tx: Transaction): number {
  return tx.status === TransactionStatus.REVERTED
    ? getSourceChainId(tx)
    : getDestChainId(tx);
}

export enum TransactionStatus {
  PENDING = 0,
  SUBMITTED = 1,    // Tx submitted to the network
  COMPLETED = 2,    // Tx successfully executed
  INCOMPLETED = 3,  // Tx submitted to chain but not processed by the chain
  FAILED = 4,       // Tx failed in execution on chain
  REVERTED = 5,     // Tx returned to sender (source bridge tx didn't meet criteria)
}

export enum TransactionType {
  BRIDGE_IN = 0,    // Liberdus → EVM: observer detects Liberdus transfer, party calls bridgeIn on EVM
  BRIDGE_OUT = 1,   // EVM → Liberdus: observer detects BridgedOut on EVM, party sends coin on Liberdus
  BRIDGE_VAULT = 2, // VAULT to SECONDARY (vault chain → secondary EVM chain)
}

export function isTransactionType(value: unknown): value is TransactionType {
  return (
    value === TransactionType.BRIDGE_IN ||
    value === TransactionType.BRIDGE_OUT ||
    value === TransactionType.BRIDGE_VAULT
  );
}

export function isTransactionStatus(
  value: unknown
): value is TransactionStatus {
  return (
    value === TransactionStatus.PENDING ||
    value === TransactionStatus.SUBMITTED ||
    value === TransactionStatus.COMPLETED ||
    value === TransactionStatus.INCOMPLETED ||
    value === TransactionStatus.FAILED ||
    value === TransactionStatus.REVERTED
  );
}

function getStatusLabel(status: TransactionStatus): string {
  switch (status) {
    case TransactionStatus.PENDING:
      return "Pending";
    case TransactionStatus.SUBMITTED:
      return "Submitted";
    case TransactionStatus.COMPLETED:
      return "Completed";
    case TransactionStatus.INCOMPLETED:
      return "Incompleted";
    case TransactionStatus.FAILED:
      return "Failed";
    case TransactionStatus.REVERTED:
      return "Reverted";
    default:
      return `Unknown(${status})`;
  }
}

function shouldShowReasonTooltip(status: TransactionStatus): boolean {
  return (
    status === TransactionStatus.INCOMPLETED ||
    status === TransactionStatus.FAILED ||
    status === TransactionStatus.REVERTED
  );
}

function formatReasonText(reason: string): string {
  return reason
    .replace(/\\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/({|\[)/g, "$1\n  ")
    .replace(/(}|])/g, "\n$1")
    .replace(/,(?!\s*[\n}])/g, ",\n  ");
}

function getReasonFromHistory(executionHistory?: string | null): string | null {
  if (!executionHistory) return null;

  try {
    const parsed: unknown = JSON.parse(executionHistory);
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed)
      : [];

    for (const entry of entries.reverse()) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "reason" in entry &&
        typeof (entry as { reason?: unknown }).reason === "string" &&
        (entry as { reason: string }).reason.trim()
      ) {
        return (entry as { reason: string }).reason;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getTransactionReason(tx: Transaction): string | null {
  const directReason = tx.reason?.trim();
  if (directReason) return directReason;
  return getReasonFromHistory(tx.executionHistory);
}

function BridgeTransactions() {
  const PAGE_SIZE = 10;
  const [totalTransactions, setTotalTransactions] = useState<number>(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("transaction");
  const [searchError, setSearchError] = useState("");
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const [tooltipVisible, setTooltipVisible] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({
    x: 0,
    y: 0,
    showBelow: false,
  });
  const [tooltipReady, setTooltipReady] = useState(false);
  const tooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const proxyRrIdxRef = useRef(0);
  const activeRequestIdRef = useRef(0);
  const unfilteredTxCacheRef = useRef<Map<string, Transaction>>(new Map());

  const mergeIntoUnfilteredCache = useCallback((incoming: Transaction[]): Transaction[] => {
    for (const tx of incoming) {
      unfilteredTxCacheRef.current.set(tx.txId, tx);
    }
    return Array.from(unfilteredTxCacheRef.current.values()).sort(
      (a, b) => (b.txTimestamp ?? 0) - (a.txTimestamp ?? 0)
    );
  }, []);

  const getTransactionsBaseUrls = useCallback((): string[] => {
    // In observer-direct mode, call observers directly first.
    const observerUrls = (networkConfig.observerUrls ?? []).filter(Boolean);
    if (networkConfig.notifyObserverDirectly && observerUrls.length > 0) {
      return observerUrls;
    }

    // Otherwise prefer reverse proxy for centralized routing.
    const proxyUrls = [networkConfig.liberdusProxyUrl]
      .filter(Boolean)
      .map((u) => `${u}/observer`);
    if (proxyUrls.length > 0) return proxyUrls;

    // Fallback to observers directly (no "/observer" prefix on observer service).
    if (observerUrls.length > 0) return observerUrls;

    // Last resort: coordinator (legacy/emergency).
    if (networkConfig.coordinatorUrl) return [networkConfig.coordinatorUrl];
    return [];
  }, []);

  const buildTxUrl = useCallback(
    (baseUrl: string, {
      page = 1,
      txId,
      sender,
      type,
      status,
    }: {
      page?: number;
      txId?: string;
      sender?: string;
      type?: TransactionType;
      status?: TransactionStatus;
    } = {}) => {
      const params = new URLSearchParams();
      if (txId) {
        const trimmed = txId.trim();
        const normalized = trimmed.toLowerCase().startsWith("0x")
          ? trimmed.toLowerCase().slice(2)
          : trimmed.toLowerCase();
        params.set("txId", normalized);
      } else if (sender) {
        params.set("sender", toEthereumAddress(sender).toLowerCase());
        params.set("page", String(page));
      } else if (isTransactionType(type)) {
        params.set("type", String(type));
        params.set("page", String(page));
      } else if (isTransactionStatus(status)) {
        params.set("status", String(status));
        params.set("page", String(page));
      } else {
        params.set("page", String(page));
      }
      return `${baseUrl}/transaction?${params.toString()}`;
    },
    []
  );

  const fetchTransactions = useCallback(async ({
    page = 1,
    txId,
    sender,
    type,
    status,
    silent = false,
  }: {
    page?: number;
    txId?: string;
    sender?: string;
    type?: TransactionType;
    status?: TransactionStatus;
    silent?: boolean;
  } = {}) => {
    const requestId = ++activeRequestIdRef.current;
    if (!silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const baseUrls = getTransactionsBaseUrls();
      if (baseUrls.length === 0) throw new Error("No observer/coordinator URLs configured");

      const startIdx = proxyRrIdxRef.current % baseUrls.length;
      proxyRrIdxRef.current = (proxyRrIdxRef.current + 1) % baseUrls.length;

      let lastErr: unknown = null;
      for (let i = 0; i < baseUrls.length; i++) {
        const baseUrl = baseUrls[(startIdx + i) % baseUrls.length];
        const txURL = buildTxUrl(baseUrl, { page, txId, sender, type, status });
        try {
          const response = await fetch(txURL);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const incoming: Transaction[] = data?.Ok?.transactions ?? [];
          const isUnfilteredRequest =
            !txId && !sender && type === undefined && status === undefined;

          // A newer request started while this one was in-flight.
          if (requestId !== activeRequestIdRef.current) return;

          let next = incoming;
          if (isUnfilteredRequest) {
            const merged = mergeIntoUnfilteredCache(incoming);
            const start = (page - 1) * PAGE_SIZE;
            const end = start + PAGE_SIZE;
            const cachedSlice = merged.slice(start, end);
            // Prefer cached slice when available so list remains stable across updates.
            if (cachedSlice.length > 0 || page === 1) {
              next = cachedSlice;
            }
          }
          setTransactions(next);
          const totalFromApi =
            data?.Ok?.totalTransactions ??
            data?.Ok?.totalTranactions ??
            next.length;
          setTotalTransactions(totalFromApi);
          setTotalPages(data?.Ok?.totalPages ?? Math.max(1, Math.ceil(totalFromApi / PAGE_SIZE)));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          continue;
        }
      }
      if (lastErr) throw lastErr;
    } catch (err) {
      if (requestId === activeRequestIdRef.current) {
        setError("Failed to fetch bridge transactions");
        console.error("Error fetching transactions:", err);
      }
    } finally {
      if (!silent && requestId === activeRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [buildTxUrl, getTransactionsBaseUrls, mergeIntoUnfilteredCache]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  // Auto-refresh first page in the background so new transactions appear without full reloads.
  useEffect(() => {
    if (isSearchActive || page !== 1) return;
    const id = setInterval(() => {
      void fetchTransactions({ page: 1, silent: true });
    }, 15000);
    return () => clearInterval(id);
  }, [fetchTransactions, isSearchActive, page]);

  const searchTypes = [
    {
      value: "transaction",
      label: "Transaction ID",
      placeholder: "Enter transaction ID...",
    },
    {
      value: "sender",
      label: "Sender Address",
      placeholder: "Enter sender address...",
    },
    {
      value: "type",
      label: "Bridge Type",
      placeholder:
        "Enter bridge type... ( in: bridge in, out: bridge out, vault: bridge vault )",
    },
    {
      value: "status",
      label: "Transaction Status",
      placeholder:
        "Enter transaction status... ( 0: pending, 1: submitted, 2: completed, 3: incompleted, 4: failed, 5: reverted )",
    },
  ];

  const currentSearchType = searchTypes.find(
    (type) => type.value === searchType
  );

  const validateSearchQuery = useCallback(
    (searchType: string, query: string, page = 1): boolean => {
      switch (searchType) {
        case "transaction":
          if (
            query.length !== 64 &&
            !(query.startsWith("0x") && query.length === 66)
          ) {
            setSearchError("Invalid transaction ID format");
            return false;
          }
          fetchTransactions({ txId: query });
          break;

        case "sender":
          if (!ethers.isAddress(query)) {
            setSearchError("Invalid sender address format");
            return false;
          }
          fetchTransactions({ sender: query, page });
          break;

        case "type":
          if (query !== "in" && query !== "out" && query !== "vault") {
            setSearchError("Invalid bridge type. Use 'in', 'out', or 'vault'.");
            return false;
          }
          fetchTransactions({
            type:
              query === "in"
                ? TransactionType.BRIDGE_IN
                : query === "vault"
                ? TransactionType.BRIDGE_VAULT
                : TransactionType.BRIDGE_OUT,
            page,
          });
          break;

        case "status":
          const queryAsNumber = parseInt(query);
          if (!isTransactionStatus(queryAsNumber)) {
            setSearchError("Invalid status. Use '0', '1', '2', '3', '4' or '5'.");
            return false;
          }
          fetchTransactions({ status: queryAsNumber, page });
          break;

        default:
          setSearchError("Invalid search");
          return false;
      }

      return true; // ✅ passed validation
    },
    [fetchTransactions]
  );

  useEffect(() => {
    if (!searchQuery.trim()) return;

    const timeout = setTimeout(() => {
      const query = searchQuery.toLowerCase().trim();
      const isValid = validateSearchQuery(searchType, query, 1);
      setIsSearchActive(true);
      if (isValid) {
        setSearchError("");
      }
    }, 500); // debounce

    return () => clearTimeout(timeout);
  }, [searchQuery, searchType, validateSearchQuery]);

  const clearAllFilters = () => {
    setIsSearchActive(false);
    setSearchQuery("");
    setPage(1);
    fetchTransactions({ page: 1 });
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);

    if (isSearchActive && searchQuery.trim()) {
      // Refresh the current search query
      const query = searchQuery.toLowerCase().trim();
      validateSearchQuery(searchType, query, page);
    } else {
      // Refresh all transactions
      await fetchTransactions({ page });
    }

    // Add a small delay to show the refresh animation
    setTimeout(() => {
      setIsRefreshing(false);
    }, 500);
  };

  // Handle outside clicks
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isDropdownOpen]);

  const getBridgeChainName = (chainId: number): string => {
    if (chainId === LIBERDUS_CHAIN_ID) return "Liberdus Network";
    return getChainName(chainId);
  };

  const getChainColor = (chainId: number): string => {
    const chainColors: Record<number, string> = {
      [LIBERDUS_CHAIN_ID]: colors.chain.liberdus,
      80002: colors.chain.polygon,
      137: colors.chain.polygon,
      11155111: colors.chain.ethereum,
      1: colors.chain.ethereum,
      97: colors.chain.bsc,
      56: colors.chain.bsc,
    };
    return chainColors[chainId] || colors.chain.default;
  };

  const formatValue = (value: string) => {
    // Convert wei to ETH for display
    try {
      const amount = BigInt(value);
      const ethValue = ethers.formatEther(amount);
      return ethValue + " LIB";
    } catch {
      return value;
    }
  };

  const formatAddress = (address: string) => {
    if (!address) return "";
    const ethAddress = toEthereumAddress(address);
    return `${ethAddress.slice(0, 6)}...${ethAddress.slice(-4)}`;
  };

  const formatDate = (txTimestamp?: number) => {
    if (!txTimestamp) return "N/A";
    return moment(txTimestamp).fromNow();
  };

  const getStatusColor = (status: TransactionStatus) => {
    switch (status) {
      case TransactionStatus.COMPLETED:
        return colors.status.success;
      case TransactionStatus.PENDING:
      case TransactionStatus.SUBMITTED:
      case TransactionStatus.INCOMPLETED:
        return colors.status.warning;
      case TransactionStatus.FAILED:
        return colors.status.error;
      case TransactionStatus.REVERTED:
        return colors.status.infoText;
      default:
        return colors.text.muted;
    }
  };

  const getStatusBg = (status: TransactionStatus) => {
    switch (status) {
      case TransactionStatus.COMPLETED:
        return colors.status.successBg;
      case TransactionStatus.PENDING:
      case TransactionStatus.SUBMITTED:
      case TransactionStatus.INCOMPLETED:
        return colors.status.warningBg;
      case TransactionStatus.FAILED:
        return colors.status.errorBg;
      case TransactionStatus.REVERTED:
        return colors.status.infoBg;
      default:
        return colors.action.hover;
    }
  };

  const getStatusBorder = (status: TransactionStatus) => {
    switch (status) {
      case TransactionStatus.COMPLETED:
        return `1px solid ${colors.status.successBorder}`;
      case TransactionStatus.PENDING:
      case TransactionStatus.SUBMITTED:
      case TransactionStatus.INCOMPLETED:
        return `1px solid ${colors.status.warningBorder}`;
      case TransactionStatus.FAILED:
        return `1px solid ${colors.status.errorBorder}`;
      case TransactionStatus.REVERTED:
        return `1px solid ${colors.status.infoBorder}`;
      default:
        return `1px solid ${colors.border.subtle}`;
    }
  };

  const handleNextPage = () => {
    if (page < totalPages) {
      const nextPage = page + 1;
      if (isSearchActive) {
        const query = searchQuery.toLowerCase().trim();
        const valid = validateSearchQuery(searchType, query, nextPage);
        if (valid) setPage(nextPage);
      } else {
        setPage(nextPage);
        fetchTransactions({ page: nextPage });
      }
    }
  };

  const handlePreviousPage = () => {
    if (page > 1) {
      const prevPage = page - 1;
      if (isSearchActive) {
        const query = searchQuery.toLowerCase().trim();
        const valid = validateSearchQuery(searchType, query, prevPage);
        if (valid) setPage(prevPage);
      } else {
        fetchTransactions({ page: prevPage });
        setPage(prevPage);
      }
    }
  };

  const handleTooltipShow = (txId: string, event: React.MouseEvent) => {
    // Clear any existing timeout
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const tooltipWidth = 420; // Increased width for long messages
    const tooltipMaxHeight = 300; // Maximum height before scrolling
    const padding = 20; // Padding from window edges

    let x = rect.left + rect.width / 2;
    let y = rect.top - 10;
    let showBelow = false;

    // Adjust horizontal position if tooltip would exceed window width
    if (x + tooltipWidth / 2 > window.innerWidth - padding) {
      x = window.innerWidth - tooltipWidth / 2 - padding;
    } else if (x - tooltipWidth / 2 < padding) {
      x = tooltipWidth / 2 + padding;
    }

    // Calculate if there's enough space above for the tooltip
    const spaceAbove = rect.top - padding;
    const spaceBelow = window.innerHeight - rect.bottom - padding;

    // Show below if there's not enough space above, or if there's more space below
    if (spaceAbove < tooltipMaxHeight || spaceBelow > spaceAbove) {
      y = rect.bottom + 10;
      showBelow = true;
    }

    // Set position first, then make visible
    setTooltipPosition({ x, y, showBelow });
    setTooltipReady(false); // Reset ready state

    // Use requestAnimationFrame to ensure position is set before showing
    requestAnimationFrame(() => {
      setTooltipVisible(txId);
      requestAnimationFrame(() => {
        setTooltipReady(true);
      });
    });
  };

  const handleTooltipHide = () => {
    // Add a small delay before hiding to allow mouse to move to tooltip
    tooltipTimeoutRef.current = setTimeout(() => {
      setTooltipVisible(null);
      setTooltipReady(false);
    }, 300);
  };

  const handleTooltipMouseEnter = () => {
    // Clear the hide timeout when mouse enters tooltip
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
  };

  const handleTooltipMouseLeave = () => {
    // Hide immediately when mouse leaves tooltip
    setTooltipVisible(null);
    setTooltipReady(false);
  };

  return (
    <div
      style={{
        padding: "2rem 1rem",
        overflow: "auto",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "80rem",
          margin: "0 auto",
        }}
      >
        {/* Search Filters */}
        <div
          style={{
            background: colors.background.card,
            border: `1px solid ${colors.border.subtle}`,
            borderRadius: "1rem",
            padding: "1.5rem",
            marginBottom: "1.5rem",
            boxShadow: colors.shadows.card,
            position: "relative",
            zIndex: 49, // Lower than the nav bar
          }}
        >
          {/* Header with Title, Total Transactions, and Refresh Button */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.5rem",
            }}
          >
            <label
              style={{
                fontSize: "0.875rem",
                fontWeight: "500",
                color: colors.text.secondary,
              }}
            >
              Search Transactions
            </label>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              {/* Total Transactions Display */}
              {!isSearchActive && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0.5rem 0.75rem",
                    background: colors.status.infoBg,
                    border: `1px solid ${colors.status.infoBorder}`,
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                    fontWeight: "400",
                    color: colors.status.infoText,
                  }}
                >
                  Total Transactions: {totalTransactions.toLocaleString()}
                </div>
              )}

              {/* Refresh Button */}
              <button
                onClick={handleRefresh}
                disabled={loading || isRefreshing}
                style={{
                  padding: "0.25rem",
                  background:
                    loading || isRefreshing
                      ? colors.action.hover
                      : colors.status.successBg,
                  border:
                    loading || isRefreshing
                      ? `1px solid ${colors.border.subtle}`
                      : `1px solid ${colors.status.successBorder}`,
                  borderRadius: "0.5rem",
                  color: loading || isRefreshing ? colors.text.muted : colors.status.success,
                  cursor: loading || isRefreshing ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "2rem",
                  height: "2rem",
                }}
                onMouseEnter={(e) => {
                  if (!loading && !isRefreshing) {
                    e.currentTarget.style.background = colors.status.successBorder;
                    e.currentTarget.style.transform = "scale(1.05)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!loading && !isRefreshing) {
                    e.currentTarget.style.background = colors.status.successBg;
                    e.currentTarget.style.transform = "scale(1)";
                  }
                }}
                title={
                  loading || isRefreshing
                    ? "Refreshing..."
                    : "Refresh transactions"
                }
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    animation: isRefreshing
                      ? "spin 1s linear infinite"
                      : "none",
                  }}
                >
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M3 21v-5h5" />
                </svg>
              </button>
            </div>
          </div>

          <div style={{ position: "relative" }}>
            <div
              style={{
                display: "flex",
                position: "relative",
                background: colors.background.input,
                border: `1px solid ${colors.border.subtle}`,
                borderRadius: "0.5rem",
                overflow: "visible",
              }}
            >
              {/* Search Type Dropdown */}
              <div
                ref={dropdownRef}
                style={{ position: "relative", zIndex: 101 }}
              >
                <button
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  style={{
                    padding: "0.75rem 1rem",
                    background: isDropdownOpen
                      ? colors.primary.bg
                      : colors.background.hover,
                    border: "none",
                    borderRight: `1px solid ${colors.border.subtle}`,
                    color: colors.text.primary,
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    whiteSpace: "nowrap",
                    transition: "all 0.2s",
                    minWidth: "140px",
                  }}
                  onMouseEnter={(e) => {
                    if (!isDropdownOpen) {
                      e.currentTarget.style.background =
                        colors.action.hover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDropdownOpen) {
                      e.currentTarget.style.background =
                        colors.background.hover;
                    }
                  }}
                >
                  <span>{currentSearchType?.label}</span>
                  <span
                    style={{
                      transform: isDropdownOpen
                        ? "rotate(180deg)"
                        : "rotate(0deg)",
                      transition: "transform 0.2s",
                      fontSize: "0.75rem",
                    }}
                  >
                    ▼
                  </span>
                </button>

                {/* Dropdown Menu */}
                {isDropdownOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: "0",
                      minWidth: "200px",
                      background: colors.background.card,
                      border: `1px solid ${colors.border.subtle}`,
                      borderRadius: "0.5rem",
                      marginTop: "0.25rem",
                      zIndex: 1001,
                      boxShadow: colors.shadows.xl,
                    }}
                  >
                    {searchTypes.map((type) => (
                      <button
                        key={type.value}
                        onClick={() => {
                          setSearchType(type.value);
                          setIsDropdownOpen(false);
                          setSearchQuery(""); // Clear search when changing type
                        }}
                        style={{
                          width: "100%",
                          padding: "0.75rem 1rem",
                          background:
                            searchType === type.value
                              ? colors.action.selected
                              : "transparent",
                          border: "none",
                          color:
                            searchType === type.value ? colors.primary.main : colors.text.secondary,
                          fontSize: "0.875rem",
                          fontWeight: searchType === type.value ? "600" : "400",
                          textAlign: "left",
                          cursor: "pointer",
                          transition: "all 0.2s",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                        onMouseEnter={(e) => {
                          if (searchType !== type.value) {
                            e.currentTarget.style.background =
                              colors.action.hover;
                            e.currentTarget.style.color = colors.text.primary;
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (searchType !== type.value) {
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = colors.text.secondary;
                          }
                        }}
                      >
                        <span>{type.label}</span>
                        {searchType === type.value && (
                          <span
                            style={{ color: colors.primary.light, fontSize: "0.75rem" }}
                          >
                            ✓
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Search Input */}
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={currentSearchType?.placeholder}
                style={{
                  flex: "1",
                  padding: "0.75rem 1rem",
                  background: "transparent",
                  border: "none",
                  color: colors.text.primary,
                  fontSize: "0.875rem",
                  outline: "none",
                }}
              />

              {/* Clear Button */}
              {isSearchActive && (
                <button
                  onClick={clearAllFilters}
                  style={{
                    padding: "0.75rem",
                    background: colors.status.errorBg,
                    border: "none",
                    borderLeft: `1px solid ${colors.border.subtle}`,
                    color: colors.status.error,
                    cursor: "pointer",
                    transition: "all 0.2s",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = colors.status.errorBorder;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = colors.status.errorBg;
                  }}
                >
                  Clear Filters
                </button>
              )}
            </div>

            {/* Search Results Info */}
            {isSearchActive && (
              <div
                style={{
                  marginTop: "1rem",
                  padding: "0.75rem 1rem",
                  background: searchError
                    ? colors.status.errorBg
                    : colors.status.infoBg,
                  border: searchError
                    ? `1px solid ${colors.status.errorBorder}`
                    : `1px solid ${colors.status.infoBorder}`,
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                  color: searchError ? colors.status.error : colors.status.infoText,
                }}
              >
                {loading
                  ? "Searching for transactions..."
                  : searchError
                  ? `Error: ${searchError}`
                  : `Found ${totalTransactions} transactions`}{" "}
                {searchQuery &&
                  ` • ${currentSearchType?.label}: "${searchQuery}"`}
              </div>
            )}
          </div>
        </div>

        {/* Main Card */}
        <div
          style={{
            background: colors.background.card,
            border: `1px solid ${colors.border.subtle}`,
            borderRadius: "1rem",
            boxShadow: colors.shadows.card,
            overflow: "hidden",
          }}
        >
          {loading && (
            <div style={{ textAlign: "center", padding: "3rem" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  color: colors.primary.main,
                  fontSize: "1.125rem",
                }}
              >
                <div
                  style={{
                    width: "1.5rem",
                    height: "1.5rem",
                    border: `2px solid ${colors.primary.bg}`,
                    borderTop: `2px solid ${colors.primary.main}`,
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                  }}
                ></div>
                <span>Loading transactions...</span>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                textAlign: "center",
                padding: "2rem",
                background: colors.status.errorBg,
                border: `1px solid ${colors.status.errorBorder}`,
                borderRadius: "1rem",
                color: colors.status.error,
                fontSize: "1rem",
                margin: "1.5rem",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            </div>
          )}

          {!loading && !error && transactions.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "3rem",
                color: colors.text.muted,
                fontSize: "1.125rem",
              }}
            >
              <div
                style={{
                  fontSize: "3rem",
                  marginBottom: "1rem",
                  opacity: 0.5,
                }}
              >
                {isSearchActive ? "🔍" : "📝"}
              </div>
              <p>
                {isSearchActive
                  ? "No transactions match your search criteria."
                  : "No bridge transactions found."}
              </p>
            </div>
          )}

          {!loading && !error && transactions.length > 0 && (
            <>
              {/* Desktop Table View */}
              <div
                style={{
                  overflowX: "auto",
                }}
                className="desktop-view"
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: colors.background.input,
                      }}
                    >
                      {["Transaction", "Sender", "Value", "Chain → Chain", "Type", "Status", "Issued", "Receipt"].map((label) => (
                        <th
                          key={label}
                          style={{
                            padding: "0.75rem 1rem",
                            textAlign: "left",
                            fontSize: "0.7rem",
                            fontWeight: "600",
                            color: colors.text.muted,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            borderBottom: `2px solid ${colors.border.subtle}`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr
                        key={tx.txId}
                        style={{
                          transition: "all 0.2s",
                          cursor: "pointer",
                        }}
                        className="transaction-row"
                      >
                        <td
                          style={{
                            padding: "0.875rem 1rem",
                            fontSize: "0.875rem",
                            color: colors.text.primary,
                            fontFamily: "monospace",
                            borderBottom: `1px solid ${colors.border.subtle}`,
                          }}
                        >
                          <a
                            href={getExplorerUrl(getSourceChainId(tx), tx.txId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: colors.text.link,
                              textDecoration: "none",
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              transition: "color 0.2s",
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.color = colors.text.linkHover)
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.color = colors.text.link)
                            }
                          >
                            <span>{formatAddress(tx.txId)}</span>
                            <span style={{ fontSize: "0.75rem" }}>↗</span>
                          </a>
                        </td>
                        <td
                          style={{
                            padding: "0.875rem 1rem",
                            fontSize: "0.875rem",
                            color: colors.text.primary,
                            fontFamily: "monospace",
                            borderBottom: `1px solid ${colors.border.subtle}`,
                          }}
                        >
                          {formatAddress(tx.sender)}
                        </td>
                        <td
                          style={{
                            padding: "0.875rem 1rem",
                            fontSize: "0.875rem",
                            color: colors.text.primary,
                            fontWeight: "600",
                            borderBottom: `1px solid ${colors.border.subtle}`,
                          }}
                        >
                          {formatValue(tx.value)}
                        </td>
                        <td style={{ padding: "0.875rem 1rem", borderBottom: `1px solid ${colors.border.subtle}` }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.375rem",
                              padding: "0.25rem 0.75rem",
                              background: colors.primary.bg,
                              border: `1px solid ${colors.primary.border}`,
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: "500",
                              color: colors.primary.main,
                              whiteSpace: "nowrap",
                            }}
                          >
                            <div
                              style={{
                                width: "0.5rem",
                                height: "0.5rem",
                                background: colors.primary.main,
                                borderRadius: "50%",
                                flexShrink: 0,
                              }}
                            ></div>
                            <span style={{ color: getChainColor(getSourceChainId(tx)) }}>{getBridgeChainName(getSourceChainId(tx))}</span>
                            <span style={{ color: colors.text.muted }}>→</span>
                            <span style={{ color: getChainColor(getDestChainId(tx)) }}>{getBridgeChainName(getDestChainId(tx))}</span>
                          </span>
                        </td>
                        <td style={{ padding: "0.875rem 1rem", borderBottom: `1px solid ${colors.border.subtle}` }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              padding: "0.25rem 0.75rem",
                              background:
                                tx.type === TransactionType.BRIDGE_IN
                                  ? colors.status.successBg
                                  : tx.type === TransactionType.BRIDGE_VAULT
                                  ? colors.primary.bg
                                  : colors.status.infoBg,
                              border:
                                tx.type === TransactionType.BRIDGE_IN
                                  ? `1px solid ${colors.status.successBorder}`
                                  : tx.type === TransactionType.BRIDGE_VAULT
                                  ? `1px solid ${colors.primary.border}`
                                  : `1px solid ${colors.status.infoBorder}`,
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: "500",
                              color:
                                tx.type === TransactionType.BRIDGE_IN
                                  ? colors.status.success
                                  : tx.type === TransactionType.BRIDGE_VAULT
                                  ? colors.primary.light
                                  : colors.status.infoText,
                            }}
                          >
                            <span>
                              {tx.type === TransactionType.BRIDGE_IN
                                ? "←"
                                : tx.type === TransactionType.BRIDGE_VAULT
                                ? "→"
                                : "→"}
                            </span>
                            <span>
                              {tx.type === TransactionType.BRIDGE_IN
                                ? "Bridge In"
                                : tx.type === TransactionType.BRIDGE_VAULT
                                ? "Bridge Vault"
                                : "Bridge Out"}
                            </span>
                          </span>
                        </td>
                        <td style={{ padding: "0.875rem 1rem", borderBottom: `1px solid ${colors.border.subtle}` }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                            }}
                          >
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                padding: "0.25rem 0.75rem",
                                background: getStatusBg(tx.status),
                                border: getStatusBorder(tx.status),
                                borderRadius: "9999px",
                                fontSize: "0.75rem",
                                fontWeight: "500",
                                color: getStatusColor(tx.status),
                              }}
                            >
                              <div
                                style={{
                                  width: "0.5rem",
                                  height: "0.5rem",
                                  background: getStatusColor(tx.status),
                                  borderRadius: "50%",
                                }}
                              ></div>
                              <span>{getStatusLabel(tx.status)}</span>
                            </span>

                            {/* Add tooltip icon for transactions that may carry failure details */}
                            {shouldShowReasonTooltip(tx.status) && (
                              <div
                                style={{
                                  position: "relative",
                                  display: "inline-block",
                                }}
                                onMouseEnter={(e) =>
                                  handleTooltipShow(tx.txId, e)
                                }
                                onMouseLeave={handleTooltipHide}
                              >
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: colors.status.error,
                                    cursor: "help",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "1.5rem",
                                    height: "1.5rem",
                                    borderRadius: "50%",
                                    background: colors.status.errorBg,
                                    border: `1px solid ${colors.status.errorBorder}`,
                                    transition:
                                      "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                                    backdropFilter: "blur(10px)",
                                    boxShadow:
                                      `0 4px 12px ${colors.status.errorBorder}`,
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.background =
                                      colors.status.errorBorder;
                                    e.currentTarget.style.transform =
                                      "scale(1.1)";
                                    e.currentTarget.style.boxShadow =
                                      `0 6px 20px ${colors.status.errorBorder}`;
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.background =
                                      colors.status.errorBg;
                                    e.currentTarget.style.transform =
                                      "scale(1)";
                                    e.currentTarget.style.boxShadow =
                                      `0 4px 12px ${colors.status.errorBorder}`;
                                  }}
                                >
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                    <polyline points="14,2 14,8 20,8"></polyline>
                                    <line x1="16" y1="13" x2="8" y2="13"></line>
                                    <line x1="16" y1="17" x2="8" y2="17"></line>
                                    <polyline points="10,9 9,9 8,9"></polyline>
                                  </svg>
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "0.875rem 1rem",
                            fontSize: "0.875rem",
                            color: colors.text.muted,
                            borderBottom: `1px solid ${colors.border.subtle}`,
                          }}
                        >
                          {formatDate(tx.txTimestamp)}
                        </td>
                        <td
                          style={{
                            padding: "0.875rem 1rem",
                            fontSize: "0.875rem",
                            color: colors.text.primary,
                            fontFamily: "monospace",
                            borderBottom: `1px solid ${colors.border.subtle}`,
                          }}
                        >
                          {!tx.receiptId ? (
                            "-"
                          ) : (
                            <a
                              href={getExplorerUrl(getReceiptChainId(tx), tx.receiptId)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: colors.primary.light,
                                textDecoration: "none",
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                transition: "color 0.2s",
                              }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.color = colors.text.linkHover)
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.color = colors.text.link)
                              }
                            >
                              <span>{formatAddress(tx.receiptId)}</span>
                              <span style={{ fontSize: "0.75rem" }}>↗</span>
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Pagination */}
          {!loading && !error && transactions.length > 0 && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                padding: "1rem 1.5rem",
                gap: "0.25rem",
                borderTop: `1px solid ${colors.border.subtle}`,
              }}
            >
              <button
                onClick={handlePreviousPage}
                disabled={page === 1}
                style={{
                  padding: "0.5rem 1rem",
                  background: page === 1 ? colors.background.input : colors.background.card,
                  border: `1px solid ${colors.border.subtle}`,
                  borderRadius: "0.5rem",
                  color: page === 1 ? colors.text.muted : colors.text.secondary,
                  fontSize: "0.8rem",
                  fontWeight: "500",
                  cursor: page === 1 ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.375rem",
                  opacity: page === 1 ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.borderColor = colors.primary.border;
                    e.currentTarget.style.color = colors.primary.main;
                    e.currentTarget.style.background = colors.primary.bg;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.borderColor = colors.border.subtle;
                    e.currentTarget.style.color = colors.text.secondary;
                    e.currentTarget.style.background = colors.background.card;
                  }
                }}
              >
                <span>←</span>
                <span>Prev</span>
              </button>
              <span
                style={{
                  padding: "0.5rem 1rem",
                  color: colors.text.secondary,
                  fontSize: "0.8rem",
                  fontWeight: "500",
                }}
              >
                {page} / {totalPages}
              </span>
              <button
                onClick={handleNextPage}
                disabled={page === totalPages}
                style={{
                  padding: "0.5rem 1rem",
                  background: page === totalPages ? colors.background.input : colors.background.card,
                  border: `1px solid ${colors.border.subtle}`,
                  borderRadius: "0.5rem",
                  color: page === totalPages ? colors.text.muted : colors.text.secondary,
                  fontSize: "0.8rem",
                  fontWeight: "500",
                  cursor: page === totalPages ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.375rem",
                  opacity: page === totalPages ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.borderColor = colors.primary.border;
                    e.currentTarget.style.color = colors.primary.main;
                    e.currentTarget.style.background = colors.primary.bg;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.borderColor = colors.border.subtle;
                    e.currentTarget.style.color = colors.text.secondary;
                    e.currentTarget.style.background = colors.background.card;
                  }
                }}
              >
                <span>Next</span>
                <span>→</span>
              </button>
            </div>
          )}
        </div>

        {tooltipVisible && (
          <div
            style={{
              position: "fixed",
              left: `${tooltipPosition.x}px`,
              top: `${tooltipPosition.y}px`,
              transform: tooltipPosition.showBelow
                ? "translateX(-50%) translateY(0%)"
                : "translateX(-50%) translateY(-100%)",
              background:
                "linear-gradient(135deg, rgba(17, 24, 39, 0.98), rgba(31, 41, 55, 0.98))",
              backdropFilter: "blur(25px)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "0.75rem",
              padding: "1rem 1.25rem",
              fontSize: "0.875rem",
              color: colors.text.inverse,
              maxWidth: "420px",
              maxHeight: "300px",
              wordWrap: "break-word",
              overflowWrap: "break-word",
              zIndex: 1000,
              boxShadow:
                "0 25px 50px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)",
              pointerEvents: "auto",
              opacity: tooltipReady ? 1 : 0,
              transition: "opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
          >
            {/* Header with icon */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.75rem",
                paddingBottom: "0.5rem",
                borderBottom: "1px solid rgba(239, 68, 68, 0.2)",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "1.25rem",
                  height: "1.25rem",
                  borderRadius: "0.25rem",
                  background: colors.status.errorBg,
                  flexShrink: 0,
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
              </div>
              <span
                style={{
                  fontWeight: "600",
                  color: colors.status.error,
                  fontSize: "0.875rem",
                  background: "linear-gradient(to right, #ef4444, #dc2626)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {(() => {
                  const tx = transactions.find((t) => t.txId === tooltipVisible);
                  return tx ? `Transaction ${getStatusLabel(tx.status)}` : "Transaction Details";
                })()}
              </span>
            </div>

            {/* Reason content with scrolling */}
            <div
              style={{
                color: colors.border.subtle,
                lineHeight: "1.5",
                fontSize: "0.8rem",
                maxHeight: "120px",
                overflowY: "auto",
                overflowX: "hidden",
                wordBreak: "break-word",
                whiteSpace: "pre-wrap",
                scrollbarWidth: "thin",
                scrollbarColor:
                  "rgba(239, 68, 68, 0.3) rgba(255, 255, 255, 0.1)",
              }}
              className="custom-scrollbar"
            >
              {(() => {
                const tx = transactions.find((t) => t.txId === tooltipVisible);
                if (!tx) return "Transaction not found.";
                const reason = getTransactionReason(tx);
                if (!reason) return "No reason available.";
                return formatReasonText(reason);
              })()}
            </div>

            {/* Enhanced tooltip arrow */}
            <div
              style={{
                position: "absolute",
                [tooltipPosition.showBelow ? "top" : "bottom"]: "-6px",
                left: "50%",
                transform: "translateX(-50%)",
                width: "0",
                height: "0",
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                [tooltipPosition.showBelow ? "borderBottom" : "borderTop"]:
                  "6px solid rgba(17, 24, 39, 0.98)",
                filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2))",
              }}
            ></div>

            {/* Subtle glow effect */}
            <div
              style={{
                position: "absolute",
                top: "-2px",
                left: "-2px",
                right: "-2px",
                bottom: "-2px",
                background:
                  "linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.05))",
                borderRadius: "0.875rem",
                zIndex: -1,
                filter: "blur(8px)",
                opacity: 0.6,
              }}
            ></div>
          </div>
        )}

        {/* Decorative Elements */}
        <div
          style={{
            position: "absolute",
            top: "8.75rem",
            left: "0rem",
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
            top: "8.75rem",
            right: "0rem",
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
        @keyframes ping {
          75%,
          100% {
            transform: scale(2);
            opacity: 0;
          }
        }
        @keyframes pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.7;
            transform: scale(1.1);
          }
        }
        @keyframes tooltipFadeIn {
          from {
            opacity: 0;
            transform: translateX(-50%) translateY(-100%) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateX(-50%) translateY(-100%) scale(1);
          }
        }
        .transaction-row:nth-child(even) td {
          background: ${colors.base.slate50};
        }
        .transaction-row:hover td {
          background: ${colors.base.slate100} !important;
        }
        .transaction-row:hover td:first-child {
          box-shadow: inset 3px 0 0 ${colors.primary.main};
        }
        .transaction-row td {
          transition: background 0.15s ease;
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(239, 68, 68, 0.3);
          border-radius: 2px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(239, 68, 68, 0.5);
        }
      `}</style>
    </div>
  );
}

export { BridgeTransactions };
