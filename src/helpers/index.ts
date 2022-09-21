import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import log from "loglevel";
import bs58 from "bs58";
import nacl from "tweetnacl";

import * as anchor from "@project-serum/anchor";
import {
    IDL,
    ShadowDriveUserStaking,
} from "../types/shadow_drive_user_staking";
import { Program } from "@project-serum/anchor";
import { SHDW_DRIVE_ENDPOINT, programId } from "../constants";
import fetch from "node-fetch";

export function loadWalletKey(keypair: string): Keypair {
    if (!keypair || keypair == "") {
        throw new Error("Keypair is required!");
    }
    const loaded = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString()))
    );
    log.debug(`Wallet public key: ${loaded.publicKey}`);
    return loaded;
}

// This helper function finds the ATA given a wallet + mint address
export async function findAssociatedTokenAddress(
    walletAddress: anchor.web3.PublicKey,
    tokenMintAddress: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
    return (
        await anchor.web3.PublicKey.findProgramAddress(
            [
                walletAddress.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                tokenMintAddress.toBuffer(),
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        )
    )[0];
}

// Convert a hex string to a byte array
export function hexToBytes(hex: string) {
    for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substring(c, 2), 16));
    return bytes;
}

export function humanSizeToBytes(input: string): number | boolean {
    const UNITS = ["kb", "mb", "gb"];
    let chunk_size = 0;
    let humanReadable = input.toLowerCase();
    let inputNumber = Number(humanReadable.slice(0, humanReadable.length - 2));
    let inputDescriptor = humanReadable.slice(
        humanReadable.length - 2,
        humanReadable.length
    );
    if (!UNITS.includes(inputDescriptor) || !inputNumber) {
        return false;
    }

    switch (inputDescriptor) {
        case "kb":
            chunk_size = 1_024;
            break;
        case "mb":
            chunk_size = 1_048_576;
            break;
        case "gb":
            chunk_size = 1_073_741_824;
            break;

        default:
            break;
    }

    return Math.ceil(inputNumber * chunk_size);
}

export function bytesToHuman(bytes: any, si = false, dp = 1) {
    const thresh = si ? 1024 : 1024;

    if (Math.abs(bytes) < thresh) {
        return bytes + " B";
    }

    const units = si
        ? ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
        : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
    let u = -1;
    const r = 10 ** dp;

    do {
        bytes /= thresh;
        ++u;
    } while (
        Math.round(Math.abs(bytes) * r) / r >= thresh &&
        u < units.length - 1
    );

    return bytes.toFixed(dp) + " " + units[u];
}
/**
 *
 * @param key {anchor.web3.PublicKey} - Public key for the wallet user
 *
 * @param totalAccounts {number} - Number of storage accounts belonging to the wallet user
 * @returns
 */
export async function getFormattedStorageAccounts(
    key: anchor.web3.PublicKey,
    totalAccounts: number
): Promise<[Array<any>, Array<anchor.web3.PublicKey>]> {
    let accountsToFetch: anchor.web3.PublicKey[] = [];

    for (let i = 0; i <= totalAccounts; i++) {
        let [acc] = await anchor.web3.PublicKey.findProgramAddress(
            [
                Buffer.from("storage-account"),
                key.toBytes(),
                new anchor.BN(i).toTwos(0).toArrayLike(Buffer, "le", 4),
            ],
            programId
        );
        accountsToFetch.push(acc);
    }

    log.debug(`Accounts to Fetch length: ${accountsToFetch.length}`);
    let accounts: any = [];

    await Promise.all(
        accountsToFetch.map(async (account) => {
            const storageAccountDetails = await fetch(
                `${SHDW_DRIVE_ENDPOINT}/storage-account-info`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        storage_account: account.toString(),
                    }),
                }
            );
            // TODO proper handling of this fetch request
            const storageAccountDetailsJson =
                await storageAccountDetails.json();
            if (
                storageAccountDetailsJson.identifier !== null &&
                typeof storageAccountDetailsJson.identifier !== "undefined"
            ) {
                accounts.push(storageAccountDetailsJson);
            }
            return storageAccountDetailsJson;
        })
    );
    let alist1 = accounts.map((account: any, idx: number) => {
        return {
            identifier: account?.identifier,
            totalStorage: account?.identifier
                ? bytesToHuman(account.reserved_bytes, true, 2)
                : null,
            storageAvailable: account?.identifier
                ? bytesToHuman(
                      account.reserved_bytes - account.current_usage,
                      true,
                      2
                  )
                : null,
            pubkey: account?.identifier
                ? new anchor.web3.PublicKey(account.storage_account)
                : null,
            toBeDeleted: account?.identifier ? account.to_be_deleted : null,
            immutable: account?.identifier ? account.immutable : null,
            version: account?.identifier ? account.version : null,
            accountCounterSeed: account?.identifier
                ? account.account_counter_seed
                : null,
        };
    });
    log.debug(`\n a1List Length: ${alist1.length}`);
    let formattedAccounts = alist1.filter((acc: any, idx: number) => {
        if (acc.identifier) {
            return acc;
        }
    });
    return [formattedAccounts, accountsToFetch];
}
export function getAnchorEnvironment(
    keypair: anchor.web3.Keypair,
    connection: anchor.web3.Connection
): [Program<ShadowDriveUserStaking>, anchor.Provider] {
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {});
    anchor.setProvider(provider);
    const programClient: Program<ShadowDriveUserStaking> = new anchor.Program(
        IDL,
        programId
    );

    return [programClient, provider];
}

export async function getStorageConfigPDA(
    programClient: Program<ShadowDriveUserStaking>
): Promise<[anchor.web3.PublicKey, number]> {
    return anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("storage-config")],
        programClient.programId
    );
}

export function chunks(array: any, size: any) {
    return Array.apply(0, new Array(Math.ceil(array.length / size))).map(
        (_: any, index: any) => array.slice(index * size, (index + 1) * size)
    );
}

export function sortByProperty(property: any) {
    return function (a: any, b: any) {
        if (typeof a[property] !== "number") {
            if (a[property].toNumber() > b[property].toNumber()) return 1;
            else if (a[property].toNumber() < b[property].toNumber()) return -1;
        } else {
            if (a[property] > b[property]) return 1;
            else if (a[property] < b[property]) return -1;
        }

        return 0;
    };
}

export function sleep(ms: number): Promise<any> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signMessage(
    message: string,
    keypair: anchor.web3.Keypair
): string {
    return bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)
    );
}

export async function validateStorageAccount(
    storageAccount: anchor.web3.PublicKey,
    connection: anchor.web3.Connection
): Promise<"V1" | "V2" | null> {
    const [progrmaClient, provider] = getAnchorEnvironment(
        new anchor.web3.Keypair(),
        connection
    );

    try {
        log.debug("trying to see if storage account is a v1 account");
        const storageAccountData =
            await progrmaClient.account.storageAccount.fetch(storageAccount);
        if (storageAccountData && storageAccountData !== null) {
            return "V1";
        } else {
            return null;
        }
    } catch (e) {
        log.debug("storage account is not a v1 account, try v2");
        try {
            const storageAccountData =
                await progrmaClient.account.storageAccountV2.fetch(
                    storageAccount
                );
            if (storageAccountData && storageAccountData !== null) {
                return "V2";
            } else {
                return null;
            }
        } catch (e) {
            // console.error(e);
            return null;
        }
    }
}

/**
 * Validates if a storage account is of a specific type (V1 or V2)
 * @param storageAccount
 * @param type "V1" or "V2"
 * @param connection
 * @returns Promise<boolean>
 */
export async function validateStorageAccountType(
    storageAccount: anchor.web3.PublicKey,
    type: "V1" | "V2",
    connection: anchor.web3.Connection
): Promise<boolean> {
    const [programClient, provider] = getAnchorEnvironment(
        new anchor.web3.Keypair(),
        connection
    );
    if (type === "V1") {
        try {
            const storageAccountData =
                await programClient.account.storageAccount.fetch(
                    storageAccount
                );
            if (storageAccountData && storageAccountData !== null) {
                return true;
            } else {
                return false;
            }
        } catch (e) {
            console.error(e);
            return false;
        }
    } else {
        try {
            const storageAccountData =
                await programClient.account.storageAccountV2.fetch(
                    storageAccount
                );
            if (storageAccountData && storageAccountData !== null) {
                return true;
            } else {
                return false;
            }
        } catch (e) {
            console.error(e);
            return false;
        }
    }
}
