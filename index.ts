
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const COOKIE = process.env.ROBLOSECURITY;

if (!COOKIE) {
    console.error("❌ | Missing ROBLOSECURITY in .env");
    process.exit(1);
}

const BASE_URL = "https://economy.roblox.com";
const USERS_URL = "https://users.roblox.com";

const TRANSACTION_TYPES = [
    "AffiliateSale",
    "CurrencyPurchase",
    "EngagementPayout",
    "GroupPayout",
    "PremiumStipend",
    "Purchase",
] as const;

type TransactionType = typeof TRANSACTION_TYPES[number];

interface RobloxUser {
    id: number;
    name: string;
    displayName: string;
}

interface Transaction {
    id: number;
    transactionType: string;
    created: string;
    currency: {
        amount: number;
        type: string;
    };
    details?: {
        name?: string;
        id?: number;
        type?: string;
    };
    agent?: {
        id?: number;
        type?: string;
    };
}

interface TransactionResponse {
    previousPageCursor: string | null;
    nextPageCursor: string | null;
    data: Transaction[];
}

const sleep = (ms: number) =>
    new Promise(resolve => setTimeout(resolve, ms));

const MIN_REQUEST_DELAY = 3000;
const MAX_REQUEST_DELAY = 5000;

function randomDelay(): number {
    return Math.floor(
        Math.random() *
            (MAX_REQUEST_DELAY - MIN_REQUEST_DELAY + 1)
    ) + MIN_REQUEST_DELAY;
}

function log(message: string) {
    console.log(message);
}

function success(message: string) {
    console.log(`✅ | ${message}`);
}

function warning(message: string) {
    console.log(`⚠️  | ${message}`);
}

function error(message: string) {
    console.log(`❌ | ${message}`);
}

async function robloxRequest<T>(
    url: string,
    options: RequestInit = {},
    retry = true
): Promise<T> {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Cookie: `.ROBLOSECURITY=${COOKIE}`,
            "User-Agent": "RobloxTransactionAnalyzer/1.0",
            ...(options.headers ?? {}),
        },
    });

    if (response.status === 429) {
        if (!retry) {
            throw new Error("Rate limited after retry.");
        }

        warning("Ratelimited. Waiting 30 seconds.");

        await sleep(30_000);

        return robloxRequest<T>(url, options, false);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");

        throw new Error(
            `Roblox API returned ${response.status}${
                body ? `: ${body}` : ""
            }`
        );
    }

    return response.json() as Promise<T>;
}

async function validateCookie(): Promise<RobloxUser> {
    const response = await fetch(
        `${USERS_URL}/v1/users/authenticated`,
        {
            headers: {
                Cookie: `.ROBLOSECURITY=${COOKIE}`,
                "User-Agent": "RobloxTransactionAnalyzer/1.0",
            },
        }
    );

    if (response.status === 401) {
        throw new Error("Invalid or expired Roblox cookie.");
    }

    if (!response.ok) {
        throw new Error(
            `Failed to validate cookie. HTTP ${response.status}`
        );
    }

    return response.json() as Promise<RobloxUser>;
}

async function fetchTransactions(
    userId: number,
    transactionType: TransactionType
): Promise<Transaction[]> {
    log(
        `Beginning to fetch ${transactionType} transactions.`
    );

    log(
        `Fetching first page of ${transactionType} transactions.`
    );

    const transactions: Transaction[] = [];

    let cursor: string | null = null;
    let firstPage = true;
    let page = 0;

    while (true) {
        page++;

        const params = new URLSearchParams({
            transactionType,
            limit: "100",
        });

        if (cursor) {
            params.set("cursor", cursor);
        }

        const url =
            `${BASE_URL}/v2/users/${userId}/transactions?` +
            params.toString();

        const result =
            await robloxRequest<TransactionResponse>(url);

        transactions.push(...result.data);

        if (firstPage) {
            success(
                `Fetched initial ${result.data.length} transactions.`
            );

            log(
                `Starting to paginate through ${transactionType} transactions.`
            );

            firstPage = false;
        } else if (result.data.length > 0) {
            success(
                `Fetched ${result.data.length} more transactions`
            );
        }

        cursor = result.nextPageCursor;

        if (!cursor) {
            break;
        }

        const delay = randomDelay();

        log(
            `Waiting ${(delay / 1000).toFixed(1)} seconds before next page...`
        );

        await sleep(delay);
    }

    return transactions;
}

function getAmount(transaction: Transaction): number {
    return transaction.currency?.amount ?? 0;
}

function getTransactionName(
    transaction: Transaction
): string {
    return (
        transaction.details?.name ??
        transaction.details?.type ??
        `Transaction #${transaction.id}`
    );
}

interface Analysis {
    paidOut: number;
    spent: number;
    robuxPurchased: number;

    mostExpensive: {
        name: string;
        amount: number;
        id: number;
    } | null;

    transactionCounts: Record<
        TransactionType,
        number
    >;
}

function calculate(
    transactions: Record<
        TransactionType,
        Transaction[]
    >
): Analysis {
    const paidOutTypes: TransactionType[] = [
        "AffiliateSale",
        "EngagementPayout",
        "GroupPayout",
        "PremiumStipend",
    ];

    let paidOut = 0;

    for (const type of paidOutTypes) {
        for (const transaction of transactions[type]) {
            paidOut += Math.max(
                0,
                getAmount(transaction)
            );
        }
    }

    let spent = 0;

    let mostExpensive:
        Analysis["mostExpensive"] = null;

    for (const transaction of transactions.Purchase) {
        const amount = Math.abs(
            getAmount(transaction)
        );

        spent += amount;

        if (
            !mostExpensive ||
            amount > mostExpensive.amount
        ) {
            mostExpensive = {
                name: getTransactionName(transaction),
                amount,
                id: transaction.id,
            };
        }
    }

    let robuxPurchased = 0;

    for (
        const transaction of
        transactions.CurrencyPurchase
    ) {
        robuxPurchased += Math.abs(
            getAmount(transaction)
        );
    }

    return {
        paidOut,
        spent,
        robuxPurchased,
        mostExpensive,

        transactionCounts: {
            AffiliateSale:
                transactions.AffiliateSale.length,

            CurrencyPurchase:
                transactions.CurrencyPurchase.length,

            EngagementPayout:
                transactions.EngagementPayout.length,

            GroupPayout:
                transactions.GroupPayout.length,

            PremiumStipend:
                transactions.PremiumStipend.length,

            Purchase:
                transactions.Purchase.length,
        },
    };
}

async function storeAttempt(
    directory: string,
    user: RobloxUser,
    transactions: Record<
        TransactionType,
        Transaction[]
    >,
    analysis: Analysis
) {
    await fs.mkdir(directory, {
        recursive: true,
    });

    await fs.writeFile(
        path.join(directory, "user.json"),
        JSON.stringify(user, null, 2),
        "utf8"
    );

    await fs.writeFile(
        path.join(directory, "transactions.json"),
        JSON.stringify(transactions, null, 2),
        "utf8"
    );

    await fs.writeFile(
        path.join(directory, "analysis.json"),
        JSON.stringify(analysis, null, 2),
        "utf8"
    );
}

function printResults(analysis: Analysis) {
    console.log();

    console.log("TRANSACTION SUMMARY");

    console.log();

    console.log(
        `Amount People Have Paid You Out: ${analysis.paidOut.toLocaleString()} Robux`
    );

    console.log(
        `Amount Spent On Items: ${analysis.spent.toLocaleString()} Robux`
    );

    if (analysis.mostExpensive) {
        console.log(
            `Most Expensive Thing Purchased: ${analysis.mostExpensive.name} (${analysis.mostExpensive.amount.toLocaleString()} Robux)`
        );
    } else {
        console.log(
            "Most Expensive Thing Purchased: None"
        );
    }

    console.log(
        `Amount of Robux Purchased: ${analysis.robuxPurchased.toLocaleString()} Robux`
    );

    console.log();

    console.log("Transaction Counts");

    for (
        const [type, count] of Object.entries(
            analysis.transactionCounts
        )
    ) {
        console.log(
            `${type.padEnd(22)} ${count.toLocaleString()}`
        );
    }

    console.log();
}

async function main() {
    try {
        const user = await validateCookie();

        success(
            `Cookie is valid! User ID: ${user.id}, Username: ${user.name}`
        );

        const attemptId =
            crypto.randomBytes(16).toString("hex");

        const attemptDirectory = path.join(
            process.cwd(),
            "attempts",
            attemptId
        );

        log(
            `Storing attempt under directory ${attemptId}`
        );

        const transactions =
            {} as Record<
                TransactionType,
                Transaction[]
            >;

        for (
            const transactionType of
            TRANSACTION_TYPES
        ) {
            transactions[transactionType] =
                await fetchTransactions(
                    user.id,
                    transactionType
                );

            if (
                transactionType !==
                TRANSACTION_TYPES[
                    TRANSACTION_TYPES.length - 1
                ]
            ) {
                const delay = randomDelay();

                log(
                    `Waiting ${(delay / 1000).toFixed(1)} seconds before next transaction type...`
                );

                await sleep(delay);
            }
        }

        const analysis = calculate(
            transactions
        );

        await storeAttempt(
            attemptDirectory,
            user,
            transactions,
            analysis
        );

        console.log();

        success(
            "Finished fetching all transactions."
        );

        success(
            `Saved transaction data to ${path.relative(
                process.cwd(),
                attemptDirectory
            )}`
        );

        printResults(analysis);
    } catch (err) {
        error(
            err instanceof Error
                ? err.message
                : String(err)
        );

        process.exit(1);
    }
}

main();
