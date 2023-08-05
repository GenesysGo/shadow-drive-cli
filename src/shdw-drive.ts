#!/usr/bin/env node
import * as fs from "fs";
import ora from "ora";
import * as path from "path";
import prompts from "prompts";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { program } from "commander";
import log from "loglevel";
import { BYTES_PER_GIB, tokenMint } from "./constants";
import {
    bytesToHuman,
    findAssociatedTokenAddress,
    getAnchorEnvironment,
    getFormattedStorageAccounts,
    humanSizeToBytes,
    loadWalletKey,
    parseScientific,
    sortByProperty,
    validateStorageAccount,
} from "./helpers";
import cliProgress from "cli-progress";
import { ShadowDriveResponse, ShdwDrive, UserInfo } from "@shadow-drive/sdk";
import { from, map, mergeMap, tap, toArray } from "rxjs";
import mime from "mime-types";

program.version("0.5.0");
program.description(
    "CLI for interacting with Shade Drive. This tool uses Solana's Mainnet-Beta network with an internal RPC configuration. It does not use your local Solana configurations."
);

log.setLevel(log.levels.INFO);

log.info(
    "This is beta software running on Solana's Mainnet. Use at your own discretion."
);

programCommand("create-storage-account")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will create the storage account"
    )
    .requiredOption(
        "-n, --name <string>",
        "What you want your storage account to be named. (Does not have to be unique)"
    )
    .requiredOption(
        "-s, --size <string>",
        "Amount of storage you are requesting to create. Should be in a string like '1KB', '1MB', '1GB'. Only KB, MB, and GB storage delineations are supported currently."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const storageConfig = drive.storageConfigPDA;

        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        let storageConfigInfo;
        try {
            storageConfigInfo = await programClient.account.storageConfig.fetch(
                storageConfig
            );
        } catch (e) {
            log.error(
                `Unable to retrieve Shadow Drive storage config account.\n${e}`
            );
            return process.exit(0);
        }
        if (!storageConfigInfo) return process.exit(0);
        // If userInfo hasn't been initialized, default to 0 for account seed
        let userInfoAccount = await UserInfo.fetch(connection, userInfo);
        let accountSeed = new anchor.BN(0);
        if (userInfoAccount !== null) {
            let userInfoData = await programClient.account.userInfo.fetch(
                userInfo
            );
            accountSeed = new anchor.BN(userInfoData.accountCounter);
        } else {
            // If no userInfo, force the user to agree to TOS or don't continue.
            const agreesToTos = await prompts({
                type: "confirm",
                name: "confirm",
                message:
                    "By creating your first storage account on Shadow Drive, you agree to the Terms of Service as outlined here: https://shadowdrive.org. Confirm?",
                initial: false,
            });
            if (!agreesToTos.confirm) {
                log.error(
                    "You must agree to the Terms of Service before creating your first storage account on Shadow Drive."
                );
                return process.exit(0);
            }
        }

        let storageInput = options.size;
        let storageInputAsBytes = humanSizeToBytes(storageInput);
        if (storageInputAsBytes === false) {
            log.error(
                `${options.size} is not a valid input for size. Please use a string like '1KB', '1MB', '1GB'.`
            );
            return process.exit(0);
        }
        const shadesPerGib = storageConfigInfo.shadesPerGib;
        const storageInputBigInt = new anchor.BN(Number(storageInputAsBytes));
        const bytesPerGib = new anchor.BN(BYTES_PER_GIB);
        // Storage * shades per gib / bytes in a gib
        const accountCostEstimate = storageInputBigInt
            .mul(shadesPerGib)
            .div(bytesPerGib);
        const accountCostUiAmount = parseScientific(
            accountCostEstimate.div(new anchor.BN(10 ** 9)).toString()
        );

        const confirmStorageCost = await prompts({
            type: "confirm",
            name: "acceptStorageCost",
            message: `This storage account will require an estimated ${accountCostUiAmount} SHDW to setup. Would you like to continue?`,
            initial: false,
        });
        if (!confirmStorageCost.acceptStorageCost) {
            log.error(
                "You must accept the estimated storage cost to continue."
            );
            return process.exit(0);
        }

        log.debug("storageInputAsBytes", storageInputAsBytes);

        let ata;
        try {
            ata = await findAssociatedTokenAddress(
                keypair.publicKey,
                tokenMint
            );
        } catch (e) {
            log.error(`Unable to retrieve Associated token account.\n${e}`);
            return process.exit(0);
        }
        log.debug("Associated token account: ", ata.toString());

        let storageRequested = new anchor.BN(storageInputAsBytes.toString()); // 2^30 B <==> 1GB
        let identifier = options.name;

        // Retreive storageAccount
        let [storageAccount] = await anchor.web3.PublicKey.findProgramAddress(
            [
                Buffer.from("storage-account"),
                keypair.publicKey.toBytes(),
                accountSeed.toTwos(2).toArrayLike(Buffer, "le", 4),
            ],
            programClient.programId
        );

        // Retrieve stakeAccount
        let [stakeAccount] = await anchor.web3.PublicKey.findProgramAddress(
            [Buffer.from("stake-account"), storageAccount.toBytes()],
            programClient.programId
        );

        log.debug("storageRequested:", storageRequested.toNumber());
        log.debug("identifier:", identifier);
        log.debug("storageAccount:", storageAccount.toString());
        log.debug("userInfo:", userInfo.toString());
        log.debug("stakeAccount:", stakeAccount.toString());
        log.debug("Sending off initializeAccount tx");

        const txnSpinner = ora(
            "Sending transaction to cluster. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        let storageResponse;
        try {
            storageResponse = await drive.createStorageAccount(
                options.name,
                storageInput
            );
            log.info(storageResponse);
        } catch (e) {
            txnSpinner.fail(
                "Error processing transaction. See below for details:"
            );
            log.error(`${e.message}`);
            return process.exit(0);
        }
        txnSpinner.succeed(
            `Successfully created your new storage account of ${options.size} located at the following address on Solana: ${storageResponse.shdw_bucket}`
        );
        return process.exit(0);
    });

programCommand("upload-file")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will upload the file"
    )
    .requiredOption(
        "-f, --file <string>",
        "File path. Current file size limit is 1GB through the CLI."
    )
    .option(
        "-s, --storage-account <string>",
        "Storage account to upload file to."
    )
    .action(async (options, cmd) => {
        await handleUpload(options, cmd, "file");
    });

programCommand("edit-file")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will upload the file"
    )
    .requiredOption(
        "-f, --file <string>",
        "File path. Current file size limit is 1GB through the CLI. File must be named the same as the one you originally uploaded."
    )
    .requiredOption(
        "-u, --url <string>",
        "Shadow Drive URL of the file you are requesting to delete."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const storageConfig = drive.storageConfigPDA;
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const fileName = options.file.substring(
            options.file.lastIndexOf("/") + 1
        );
        const fileData = fs.readFileSync(options.file);
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }
        const splitURL: Array<string> = options.url.split("/");
        const storageAccount = new anchor.web3.PublicKey(splitURL[3]);

        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }

        let storageAccountOnChain =
            await programClient.account.storageAccountV2.fetch(storageAccount);

        log.debug({ storageAccountOnChain });

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        log.debug({ userInfoData });
        log.debug({
            fileName,
            storageConfig: storageConfig.toString(),
            storageAccount: storageAccount.toString(),
        });
        const txnSpinner = ora(
            `Sending file edit request to the cluster.`
        ).start();
        try {
            const uploadResponse = await drive.editFile(
                storageAccount,
                options.url,
                {
                    name: fileName,
                    file: fileData,
                }
            );
            txnSpinner.succeed(`File account updated: ${fileName}`);
            log.info(
                "Your finalized file location:",
                uploadResponse.finalized_location
            );
            log.info("Your updated file is immediately accessible.");
            return process.exit(0);
        } catch (e) {
            txnSpinner.fail(e.message);
            return process.exit(0);
        }
    });

async function handleUpload(
    options: any,
    cmd: any,
    mode: "file" | "directory"
) {
    const keypair = loadWalletKey(options.keypair);
    const wallet = new anchor.Wallet(keypair);
    const connection = new anchor.web3.Connection(options.rpc, "confirmed");
    const drive = await new ShdwDrive(connection, wallet).init();
    const userInfo = drive.userInfo;
    const programLogPath = path.join(
        process.cwd(),
        `shdw-drive-upload-${Math.round(new Date().getTime() / 100)}.json`
    );
    log.info(`Writing upload logs to ${programLogPath}.`);
    let filesToRead =
        mode === "directory"
            ? fs.readdirSync(path.resolve(options.directory))
            : [path.resolve(options.file)];

    if (mode === "directory" && !fs.statSync(options.directory).isDirectory()) {
        log.error("Please select a folder of files to upload.");
        return process.exit(0);
    }
    const fileSpinner = ora("Collecting all files").start();
    let tmpFileData: any = [];
    filesToRead.forEach((file) => {
        const fileName = file.substring(file.lastIndexOf("/") + 1);
        const filePath =
            mode === "directory"
                ? path.resolve(options.directory, fileName)
                : path.resolve(file);
        const fileStats = fs.statSync(filePath);
        const fileExtension = fileName.substring(fileName.lastIndexOf(".") + 1);
        const fileContentType = mime.lookup(fileExtension);
        const size = new anchor.BN(fileStats.size);
        const url = encodeURI(
            `https://shdw-drive.genesysgo.net/{replace}/${fileName}`
        );
        tmpFileData.push({
            location: filePath,
            fileName: fileName,
            fileStats,
            fileExtension,
            contentType: fileContentType,
            size,
            url,
        });
    });
    fileSpinner.succeed();

    const userInfoAccount = await UserInfo.fetch(connection, userInfo);
    if (userInfoAccount === null) {
        log.error(
            "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
        );
        return process.exit(0);
    }

    const accountsSpinner = ora("Fetching all storage accounts").start();

    let rawAccounts = await drive.getStorageAccounts();
    let [formattedAccounts] = await getFormattedStorageAccounts(rawAccounts);

    formattedAccounts = formattedAccounts.sort(
        sortByProperty("accountCounterSeed")
    );

    let storageAccount: any;
    let storageAccountData;

    accountsSpinner.succeed();
    if (!options.storageAccount) {
        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to use?",
            warn: "Not enough storage available on this account or the account is marked for deletion",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey} - ${acc.storageAvailable} available - ${acc.version}`,
                    // description: `Storage remaining: ${}`,
                    // disabled: !acc.hasEnoughStorageForFile || acc.toBeDeleted,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error(
                "You must pick a storage account to use for your upload."
            );
            return process.exit(0);
        }

        storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        storageAccountData = formattedAccounts[pickedAccount.option];
    } else {
        storageAccount = options.storageAccount;
        storageAccountData = formattedAccounts.find((account: any) => {
            const accountPubkey = new PublicKey(account.pubkey);
            if (
                account &&
                accountPubkey &&
                accountPubkey instanceof PublicKey
            ) {
                return accountPubkey.equals(new PublicKey(storageAccount));
            }
            return false;
        });
    }

    if (!storageAccount || !storageAccountData) {
        log.error(
            `Could not find storage account: ${storageAccount.toString()}`
        );
        return process.exit(0);
    }

    tmpFileData.forEach((file: any) => {
        file.url = file.url.replace("%7Breplace%7D", storageAccount.toString());
    });

    // create new progress bar
    const progress = new cliProgress.SingleBar({
        format: "Upload Progress | {bar} | {percentage}% || {value}/{total} Files",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
    });

    const concurrent = options.concurrent ? parseInt(options.concurrent) : 3;

    progress.start(tmpFileData.length, 0);

    let chunks = [];
    let indivChunk: any = [];

    function getChunkLength(array1: any[], array2: any[]) {
        let starting = array1.length;
        if (array2.length) {
            return array2.reduce(
                (total, next) => (total += next.length),
                starting
            );
        }
        return starting;
    }

    for (let chunkIdx = 0; chunkIdx < tmpFileData.length; chunkIdx++) {
        if (indivChunk.length === 0) {
            indivChunk.push(chunkIdx);
            // Handle when a fresh individual chunk is equal to the file data's length
            let allChunksSum = getChunkLength(indivChunk, chunks);
            if (allChunksSum === tmpFileData.length) {
                chunks.push(indivChunk);
                continue;
            }
            continue;
        }
        if (indivChunk.length < 5) {
            indivChunk.push(chunkIdx);
            if (chunkIdx == tmpFileData.length - 1) {
                chunks.push(indivChunk);
                indivChunk = [];
            }
        } else {
            chunks.push(indivChunk);
            indivChunk = [chunkIdx];
            let allChunksSum = getChunkLength(indivChunk, chunks);
            if (allChunksSum === tmpFileData.length) {
                chunks.push(indivChunk);
                continue;
            }
        }
    }

    const appendFileToItem = (item: any) => {
        const { fileName, ...props } = item;

        const currentFilePath =
            mode === "directory"
                ? path.resolve(options.directory, fileName)
                : options.file;
        let data = fs.readFileSync(currentFilePath);
        return {
            ...props,
            fileName,
            data,
        };
    };

    from(chunks)
        .pipe(
            // transform each chunk
            map((indivChunk: number[]) => {
                return indivChunk.map((index: number) =>
                    appendFileToItem(tmpFileData[index])
                );
            }),
            // resolve the resulting promises with concurrency
            mergeMap(
                async (items) => {
                    let fileDataChunk: any = [];
                    items.map((item) => {
                        fileDataChunk.push({
                            name: item.fileName,
                            file: fs.readFileSync(item.location),
                            url: item.url,
                        });
                    });
                    const uploadResponse = await drive.uploadMultipleFiles(
                        storageAccount,
                        fileDataChunk,
                        concurrent,
                        (items: number) => progress.increment(items)
                    );
                    return uploadResponse;
                },
                tmpFileData.length > 1 ? concurrent : 1
            ),
            // zip them up into a flat array once all are done to get full result list
            toArray(),
            map((res) => res.flat())
        )
        .subscribe((results) => {
            fs.writeFileSync(programLogPath, JSON.stringify(results));
            progress.stop();
            log.debug(results);
            log.info(`${results.length} files uploaded.`);
            return process.exit(0);
        });
}
programCommand("upload-multiple-files")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will upload the files"
    )
    .requiredOption(
        "-d, --directory <string>",
        "Path to folder of files you want to upload."
    )
    .option(
        "-s, --storage-account <string>",
        "Storage account to upload file to."
    )
    .option(
        "-c, --concurrent <number>",
        "Number of concurrent batch uploads.",
        "3"
    )
    .action(async (options, cmd) => {
        await handleUpload(options, cmd, "directory");
        return process.exit(0);
    });

programCommand("delete-file")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to the keypair file for the wallet that owns the storage account and file"
    )
    .requiredOption(
        "-u, --url <string>",
        "Shadow Drive URL of the file you are requesting to delete."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(path.resolve(options.keypair));
        log.debug("Input params:", { options });
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();

        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        log.info(
            `Retreiving the storage account associated with the file ${options.url}`
        );
        const splitURL: Array<string> = options.url.split("/");
        const storageAccount = new anchor.web3.PublicKey(splitURL[3]);
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        let storageAccountOnChain: any;
        if (storageAccountType === "V1") {
            storageAccountOnChain =
                await programClient.account.storageAccount.fetch(
                    storageAccount
                );
        }
        if (storageAccountType === "V2") {
            storageAccountOnChain =
                await programClient.account.storageAccountV2.fetch(
                    storageAccount
                );
        }
        log.debug({ storageAccountOnChain });
        let deleteResponse: ShadowDriveResponse;
        try {
            log.info(
                `Sending file delete request to cluster for file ${options.url}...`
            );
            deleteResponse = await drive.deleteFile(
                storageAccount,
                options.url
            );
        } catch (e) {
            log.error("Error with request");
            log.error(e);
            return process.exit(0);
        }
        log.info(`File ${options.url} successfully deleted`);
        return process.exit(0);
    });

programCommand("get-storage-account")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to the keypair file for the wallet that you want to find storage accounts for."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(path.resolve(options.keypair));
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account yet on Shadow Drive. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }
        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to get?",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining`,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to get.");
            return process.exit(0);
        }

        const storageAccount = formattedAccounts[pickedAccount.option];
        log.info(
            `Information for storage account ${
                storageAccount.identifier
            } - ${storageAccount.pubkey?.toString()}:`
        );
        log.info(storageAccount);
        return process.exit(0);
    });

programCommand("delete-storage-account")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that owns the storage account"
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();

        const userInfo = drive.userInfo;

        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }
        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );
        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to delete?",
            warn: "Account is marked immutable or is already requested to be deleted",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining - ${acc.immutable ? "Immutable" : "Mutable"}`,
                    disabled: acc.immutable || acc.toBeDeleted,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to add storage to.");
            return process.exit(0);
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        log.debug({
            storageAccount: storageAccount.toString(),
        });

        const txnSpinner = ora(
            "Sending storage account deletion request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const deleteStorage = await drive.deleteStorageAccount(
                storageAccount
            );
            log.info(deleteStorage);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            log.error(e.message);
            return process.exit(0);
        }
        txnSpinner.succeed(
            `Storage account deletion request successfully submitted for account ${storageAccount.toString()}. You have until the end of the current Solana Epoch to revert this account deletion request. Once the account is fully deleted, you will receive the SOL rent and SHDW staked back in your wallet.`
        );
        return process.exit(0);
    });

programCommand("undelete-storage-account")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that owns the storage account"
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }

        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message:
                "Which storage account do you want to unmark for deletion?",
            warn: "Account not marked for deletion",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining`,
                    disabled: !acc.toBeDeleted,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error(
                "You must pick a storage account to unmark for deletion."
            );
            return process.exit(0);
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        log.debug({
            storageAccount: storageAccount.toString(),
        });

        const txnSpinner = ora(
            "Sending storage account undelete request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const cancelDelete = await drive.cancelDeleteStorageAccount(
                storageAccount
            );
            log.info(cancelDelete);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            log.error(e.message);
            return process.exit(0);
        }
        txnSpinner.succeed(
            `Storage account undelete request successfully submitted for account ${storageAccount.toString()}. This account will no longer be deleted.`
        );
        return process.exit(0);
    });

programCommand("add-storage")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will upload the files"
    )
    .requiredOption(
        "-s, --size <string>",
        "Amount of storage you are requesting to add to your storage account. Should be in a string like '1KB', '1MB', '1GB'. Only KB, MB, and GB storage delineations are supported currently."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();

        let storageInput = options.size;
        let storageInputAsBytes = humanSizeToBytes(storageInput);
        if (storageInputAsBytes === false) {
            log.error(
                `${options.size} is not a valid input for size. Please use a string like '1KB', '1MB', '1GB'.`
            );
            return process.exit(0);
        }
        log.debug("storageInputAsBytes", storageInputAsBytes);
        let rawAccounts;
        try {
            rawAccounts = await drive.getStorageAccounts();
        } catch (e) {
            log.error(e.message);
            return process.exit(0);
        }
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to add storage to?",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.totalStorage
                    } reserved - ${acc.storageAvailable} remaining - ${
                        acc.immutable ? "Immutable" : "Mutable"
                    }`,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to add storage to.");
            return process.exit(0);
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        let accountType = await validateStorageAccount(
            new PublicKey(storageAccount),
            connection
        );
        if (!accountType || accountType === null) {
            log.error(
                `Storage account ${storageAccount} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        const txnSpinner = ora(
            "Sending add storage request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const addStorage = await drive.addStorage(
                storageAccount,
                storageInput
            );
            log.info(addStorage);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            log.error(e.message);
            return process.exit(0);
        }
        txnSpinner.succeed(`Storage account capacity successfully increased`);
        return process.exit(0);
    });

programCommand("reduce-storage")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that will upload the files"
    )
    .requiredOption(
        "-s, --size <string>",
        "Amount of storage you are requesting to remove from your storage account. Should be in a string like '1KB', '1MB', '1GB'. Only KB, MB, and GB storage delineations are supported currently."
    )
    .action(async (options, cmd) => {
        let storageInput = options.size;
        let storageInputAsBytes = humanSizeToBytes(storageInput);
        if (storageInputAsBytes === false) {
            log.error(
                `${options.size} is not a valid input for size. Please use a string like '1KB', '1MB', '1GB'.`
            );
            return process.exit(0);
        }
        log.debug("storageInputAsBytes", storageInputAsBytes);
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;

        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }

        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message:
                "Which storage account do you want to remove storage from?",
            warn: "Account is marked for deletion or is immutable.",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.totalStorage
                    } reserved - ${acc.storageAvailable} remaining - ${
                        acc.immutable ? "Immutable" : "Mutable"
                    }`,
                    disabled: acc.toBeDeleted || acc.immutable,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error(
                "You must pick a storage account to remove storage from."
            );
            return process.exit(0);
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }

        const txnSpinner = ora(
            "Sending reduce storage request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const reduceStorage = await drive.reduceStorage(
                storageAccount,
                storageInput
            );
            log.info(reduceStorage);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            log.error(e.message);
            return process.exit(0);
        }
        txnSpinner.succeed(`Storage account capacity successfully reduced.`);
        return process.exit(0);
    });

programCommand("make-storage-account-immutable")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that you want to make immutable"
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");

        const drive = await new ShdwDrive(connection, wallet).init();

        const userInfo = drive.userInfo;

        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }

        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );
        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to make immutable?",
            warn: "Account already immutable",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.totalStorage
                    } reserved. ${acc.immutable ? "Immutable" : "Mutable"}`,
                    disabled: acc.immutable,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to make immutable.");
            return process.exit(0);
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        const txnSpinner = ora(
            "Sending make account immutable request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const makeImmutable = await drive.makeStorageImmutable(
                storageAccount
            );
            log.info(makeImmutable);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            log.error(e.message);
            return process.exit(0);
        }
        txnSpinner.succeed(
            `Storage account ${storageAccount.toString()} has been marked as immutable. Files can no longer be deleted from this storage account.`
        );
        return process.exit(0);
    });

programCommand("claim-stake")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that owns the storage account you want to claim available stake from."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        let programConstants = Object.assign(
            {},
            ...programClient.idl.constants.map((x) => ({ [x.name]: x.value }))
        );
        const currentEpoch = (await provider.connection.getEpochInfo()).epoch;
        let unstakeEpochperiod = parseInt(
            programConstants["UNSTAKE_EPOCH_PERIOD"]
        );
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }

        const accountFetchSpinner = ora(
            "Fetching all storage accounts and claimable stake"
        ).start();
        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts, accountsToFetch] =
            await getFormattedStorageAccounts(rawAccounts);
        formattedAccounts = await Promise.all(
            formattedAccounts.map(async (account: any, idx: number) => {
                const accountKey = new anchor.web3.PublicKey(
                    accountsToFetch[idx]
                );
                let unstakeInfo, unstakeAccount;
                try {
                    [unstakeInfo] =
                        await anchor.web3.PublicKey.findProgramAddress(
                            [Buffer.from("unstake-info"), accountKey.toBytes()],
                            programClient.programId
                        );

                    [unstakeAccount] =
                        await anchor.web3.PublicKey.findProgramAddress(
                            [
                                Buffer.from("unstake-account"),
                                accountKey.toBytes(),
                            ],
                            programClient.programId
                        );
                } catch (e) {
                    return process.exit(0);
                }
                let unstakeInfoData;
                let unstakeTokenAccount;
                let unstakeTokenAccountBalance;
                try {
                    unstakeInfoData =
                        await programClient.account.unstakeInfo.fetch(
                            unstakeInfo
                        );
                } catch (e) {
                    log.debug(e.message);
                    return null;
                }
                try {
                    unstakeTokenAccountBalance =
                        await connection.getTokenAccountBalance(unstakeAccount);
                } catch (e) {
                    log.debug(e.message);
                    return null;
                }
                return {
                    ...account,
                    unstakeAccount: unstakeAccount,
                    unstakeInfoAccount: unstakeInfo,
                    unstakeInfoData: unstakeInfoData,
                    unstakeTokenAccountBalance,
                    currentEpoch,
                    claimableEpoch:
                        unstakeInfoData.epochLastUnstaked.toNumber() +
                        unstakeEpochperiod,
                };
            })
        );
        formattedAccounts = formattedAccounts.filter(
            (account: any) => account !== null
        );
        accountFetchSpinner.succeed();

        if (formattedAccounts.length === 0) {
            log.error(
                "You don't have any storage accounts with claimable stake."
            );
            return process.exit(0);
        }

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to claim stake for?",
            warn: "Account not eligible for stake claim yet. Please wait until the epoch specified.",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.unstakeTokenAccountBalance.value.uiAmount
                    } $SHDW claimable on or after Solana Epoch ${
                        acc.claimableEpoch
                    }`,
                    disabled: currentEpoch < acc.claimableEpoch,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to reduce storage on.");
            return process.exit(0);
        }
        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        const txnSpinner = ora(
            "Sending claim stake transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const claimStake = await drive.claimStake(storageAccount);
            log.info(claimStake);
            txnSpinner.succeed(
                `You have claimed ${formattedAccount.unstakeTokenAccountBalance.value.uiAmount} $SHDW from your storage account ${storageAccount}.`
            );
            return process.exit(0);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            log.error(e.message);
            return process.exit(0);
        }
    });
programCommand("refresh-stake")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that owns the storage account you want to refresh stake for."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");

        const drive = await new ShdwDrive(connection, wallet).init();

        const userInfo = drive.userInfo;
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }
        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to refresh stake?",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining`,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to refresh.");
            return process.exit(0);
        }

        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        log.info(`Picked account ${storageAccount}`);
        const txnSpinner = ora(
            "Sending refresh stake transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const refreshStake = await drive.refreshStake(storageAccount);
            log.info(refreshStake);
            txnSpinner.succeed(
                `You have refreshed stake for storage account ${storageAccount}.`
            );
            return process.exit(0);
        } catch (e: any) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            log.error(e.message);
            return process.exit(0);
        }
    });
programCommand("top-up")
    .requiredOption(
        "-kp, --keypair <string>",
        "Path to wallet that owns the storage account you want to top up stake for."
    )
    .requiredOption(
        "-a, --amount <string>",
        "Amount of $SHDW to transfer into the stake account for the selected Storage Account."
    )
    .action(async (options, cmd) => {
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");

        const drive = await new ShdwDrive(connection, wallet).init();

        const userInfo = drive.userInfo;
        const userInfoAccount = await UserInfo.fetch(connection, userInfo);
        if (userInfoAccount === null) {
            log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
            return process.exit(0);
        }

        let rawAccounts = await drive.getStorageAccounts();
        let [formattedAccounts] = await getFormattedStorageAccounts(
            rawAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to top up?",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining`,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error("You must pick a storage account to top up.");
            return process.exit(0);
        }

        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
            return process.exit(0);
        }
        log.info(`Picked account ${storageAccount}`);
        const txnSpinner = ora(
            "Sending top up transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const topUp = await drive.topUp(
                storageAccount,
                options.amount * 10 ** 9
            );
            log.info(topUp);
            txnSpinner.succeed(
                `You have added stake for storage account ${storageAccount}.`
            );
            return process.exit(0);
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            log.error(e.message);
            return process.exit(0);
        }
    });
function programCommand(name: string) {
    let shdwProgram = program
        .command(name)
        // .option(
        //   "-e, --env <string>",
        //   "Solana cluster env name (currently not used)",
        //   "devnet" //mainnet-beta, testnet, devnet
        // )
        .option(
            "-r, --rpc <string>",
            "Solana Mainnet RPC Endpoint",
            "https://api.mainnet-beta.solana.com"
        )
        .option("-l, --log-level <string>", "log level", setLogLevel);

    return shdwProgram;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value: any, prev: any) {
    if (value === undefined || value === null) {
        return;
    }
    log.info("setting the log value to: " + value);
    log.setLevel(value);
}

program.parseAsync(process.argv);
