#!/usr/bin/env node
import * as fs from "fs";
import ora from "ora";
import * as path from "path";
import prompts from "prompts";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { program } from "commander";
import log from "loglevel";
import fetch from "node-fetch";
import { BYTES_PER_GIB, SHDW_DRIVE_ENDPOINT, tokenMint } from "./constants";
import {
    bytesToHuman,
    findAssociatedTokenAddress,
    getAnchorEnvironment,
    getFormattedStorageAccounts,
    getStorageConfigPDA,
    humanSizeToBytes,
    loadWalletKey,
    parseScientific,
    sortByProperty,
    validateStorageAccount,
} from "./helpers";
import cliProgress from "cli-progress";
import { ShadowDriveResponse, ShdwDrive } from "@shadow-drive/sdk";
import { from, map, mergeMap, tap, toArray } from "rxjs";
import mime from "mime-types";

program.version("0.5.1");
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
            return;
        }
        if (!storageConfigInfo) return;
        // If userInfo hasn't been initialized, default to 0 for account seed
        let userInfoAccount = await connection.getAccountInfo(userInfo);
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
                return;
            }
        }

        let storageInput = options.size;
        let storageInputAsBytes = humanSizeToBytes(storageInput);
        if (storageInputAsBytes === false) {
            log.error(
                `${options.size} is not a valid input for size. Please use a string like '1KB', '1MB', '1GB'.`
            );
            return;
        }
        const shadesPerGib = storageConfigInfo.shadesPerGib;
        const storageInputBigInt = new anchor.BN(Number(storageInputAsBytes));
        const bytesPerGib = new anchor.BN(BYTES_PER_GIB);
        // Storage * shades per gib / bytes in a gib
        const accountCostEstimate = storageInputBigInt
            .mul(shadesPerGib)
            .div(bytesPerGib);
        const accountCostUiAmount = parseScientific(
            (accountCostEstimate / new anchor.BN(10 ** 9)).toString()
        );

        const confirmStorageCost = await prompts({
            type: "confirm",
            name: "acceptStorageCost",
            message: `This storage account will require an estimated ${accountCostUiAmount} SHDW to setup. Would you like to continue?`,
            initial: false,
        });
        if (!confirmStorageCost.acceptStorageCost) {
            return log.error(
                "You must accept the estimated storage cost to continue."
            );
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
            return;
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

        log.debug("storageRequested:", storageRequested);
        log.debug("identifier:", identifier);
        log.debug("storageAccount:", storageAccount);
        log.debug("userInfo:", userInfo);
        log.debug("stakeAccount:", stakeAccount);
        log.debug("Sending off initializeAccount tx");

        const txnSpinner = ora(
            "Sending transaction to cluster. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        let storageResponse;
        try {
            storageResponse = await drive.createStorageAccount(
                options.name,
                storageInput,
                "v2"
            );
        } catch (e) {
            txnSpinner.fail(
                "Error processing transaction. See below for details:"
            );
            log.error(`${e}`);

            return;
        }
        txnSpinner.succeed(
            `Successfully created your new storage account of ${options.size} located at the following address on Solana: ${storageResponse.shdw_bucket}`
        );
        return;
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
        return;
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
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }
        const splitURL: Array<string> = options.url.split("/");
        const storageAccount = new anchor.web3.PublicKey(splitURL[3]);

        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }

        let storageAccountOnChain;
        if (storageAccountType === "V1") {
            storageAccountOnChain =
                programClient.account.storageAccount.fetch(storageAccount);
        }
        if (storageAccountType === "V2") {
            storageAccountOnChain =
                await programClient.account.storageAccountV2.fetch(
                    storageAccount
                );
        }

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
                },
                "v2"
            );
            txnSpinner.succeed(`File account updated: ${fileName}`);
            log.info(
                "Your finalized file location:",
                uploadResponse.finalized_location
            );
            log.info("Your updated file is immediately accessible.");
        } catch (e) {
            txnSpinner.fail(e.message);
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
    const [programClient, provider] = getAnchorEnvironment(keypair, connection);
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
        return log.error("Please select a folder of files to upload.");
    }
    const fileSpinner = ora("Collecting all files").start();
    let fileData: any = [];
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
        const url = `https://shdw-drive.genesysgo.net/{replace}/${encodeURIComponent(
            fileName
        )}`;
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

    const userInfoAccount = await connection.getAccountInfo(userInfo);
    if (userInfoAccount === null) {
        return log.error(
            "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
        );
    }

    let userInfoData = await programClient.account.userInfo.fetch(userInfo);

    log.debug({ userInfoData });

    let numberOfStorageAccounts = userInfoData.accountCounter - 1;

    const accountsSpinner = ora("Fetching all storage accounts").start();

    let [formattedAccounts] = await getFormattedStorageAccounts(
        keypair.publicKey,
        numberOfStorageAccounts
    );

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
            return;
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
        return;
    }

    tmpFileData.forEach((file: any) => {
        file.url = file.url.replace("{replace}", storageAccount.toString());
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
        return;
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
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
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
                options.url,
                "v2"
            );
            log.info(`File ${options.url} successfully deleted.`);
        } catch (e) {
            log.error("Error with request");
            log.error(e);
        }

        return log.info(`File ${options.url} successfully deleted`);
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
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account yet on Shadow Drive. Please see the 'create-storage-account' command to get started."
            );
        }
        // TODO add hanlding for if userInfo is not initialized yet for a keypair
        const userInfoData = await programClient.account.userInfo.fetch(
            userInfo
        );
        const numberOfStorageAccounts = userInfoData.accountCounter - 1;
        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        const storageAccount = formattedAccounts[pickedAccount.option];
        log.info(
            `Information for storage account ${
                storageAccount.identifier
            } - ${storageAccount.pubkey?.toString()}:`
        );
        return log.info(storageAccount);
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
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;
        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        log.debug({
            storageAccount: storageAccount.toString(),
        });

        const txnSpinner = ora(
            "Sending storage account deletion request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                await drive.deleteStorageAccount(storageAccount, "v1");
            }

            if (storageAccountType === "V2") {
                await drive.deleteStorageAccount(storageAccount, "v2");
            }
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            return log.error(e);
        }
        txnSpinner.succeed(
            `Storage account deletion request successfully submitted for account ${storageAccount.toString()}. You have until the end of the current Solana Epoch to revert this account deletion request. Once the account is fully deleted, you will receive the SOL rent and SHDW staked back in your wallet.`
        );
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
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;
        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        const [stakeAccount] = await anchor.web3.PublicKey.findProgramAddress(
            [Buffer.from("stake-account"), storageAccount.toBytes()],
            programClient.programId
        );

        log.debug({
            storageAccount: storageAccount.toString(),
        });

        const txnSpinner = ora(
            "Sending storage account undelete request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                await drive.cancelDeleteStorageAccount(storageAccount, "v1");
            }

            if (storageAccountType === "V2") {
                await drive.cancelDeleteStorageAccount(storageAccount, "v2");
            }
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            return log.error(e);
        }
        txnSpinner.succeed(
            `Storage account undelete request successfully submitted for account ${storageAccount.toString()}. This account will no longer be deleted.`
        );
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
        const userInfo = drive.userInfo;

        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        let storageInput = options.size;
        let storageInputAsBytes = humanSizeToBytes(storageInput);
        if (storageInputAsBytes === false) {
            log.error(
                `${options.size} is not a valid input for size. Please use a string like '1KB', '1MB', '1GB'.`
            );
            return;
        }
        log.debug("storageInputAsBytes", storageInputAsBytes);
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;

        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        let accountType = await validateStorageAccount(
            new PublicKey(storageAccount),
            connection
        );
        if (!accountType || accountType === null) {
            return log.error(
                `Storage account ${storageAccount} is not a valid Shadow Drive Storage Account.`
            );
        }
        const [stakeAccount] = await anchor.web3.PublicKey.findProgramAddress(
            [Buffer.from("stake-account"), storageAccount.toBytes()],
            programClient.programId
        );
        const ownerAta = await findAssociatedTokenAddress(
            keypair.publicKey,
            tokenMint
        );

        log.debug({
            storageAccount: storageAccount.toString(),
            stakeAccount: stakeAccount.toString(),
            ownerAta: ownerAta.toString(),
        });

        const txnSpinner = ora(
            "Sending add storage request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            // Mutable V1 add storage
            if (accountType === "V1") {
                const addStorage = await drive.addStorage(
                    storageAccount,
                    storageInput,
                    "v1"
                );
                log.info(addStorage);
            }
            // Mutable V2 Add Storage
            if (accountType === "V2") {
                const addStorage = await drive.addStorage(
                    storageAccount,
                    storageInput,
                    "v2"
                );
                log.info(addStorage);
            }
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            return log.error(e);
        }
        txnSpinner.succeed(`Storage account capacity successfully increased`);
        return;
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
            return;
        }
        log.debug("storageInputAsBytes", storageInputAsBytes);
        const keypair = loadWalletKey(options.keypair);
        const wallet = new anchor.Wallet(keypair);
        const connection = new anchor.web3.Connection(options.rpc, "confirmed");
        const drive = await new ShdwDrive(connection, wallet).init();
        const userInfo = drive.userInfo;
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );

        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;
        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }

        const txnSpinner = ora(
            "Sending reduce storage request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                const reduceStorage = await drive.reduceStorage(
                    storageAccount,
                    storageInput,
                    "v1"
                );
                log.info(reduceStorage);
            }
            if (storageAccountType === "V2") {
                const reduceStorage = await drive.reduceStorage(
                    storageAccount,
                    storageInput,
                    "v2"
                );
                log.info(reduceStorage);
            }
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            return log.error(e);
        }
        txnSpinner.succeed(`Storage account capacity successfully reduced.`);
        return;
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
        const storageConfig = drive.storageConfigPDA;
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;
        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        const txnSpinner = ora(
            "Sending make account immutable request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                const makeImmutable = await drive.makeStorageImmutable(
                    storageAccount,
                    "v1"
                );

                log.debug(makeImmutable);
            }

            if (storageAccountType === "V2") {
                const makeImmutable = await drive.makeStorageImmutable(
                    storageAccount,
                    "v2"
                );

                log.debug(makeImmutable);
            }
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. Please see information below."
            );
            return log.error(e);
        }
        txnSpinner.succeed(
            `Storage account ${storageAccount.toString()} has been marked as immutable. Files can no longer be deleted from this storage account.`
        );
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
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;

        const accountFetchSpinner = ora(
            "Fetching all storage accounts and claimable stake"
        ).start();
        let [formattedAccounts, accountsToFetch] =
            await getFormattedStorageAccounts(
                keypair.publicKey,
                numberOfStorageAccounts
            );

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
                    return;
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
                    console.log(e);
                    return null;
                }
                try {
                    unstakeTokenAccountBalance =
                        await connection.getTokenAccountBalance(unstakeAccount);
                } catch (e) {
                    console.log(e);
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
            return log.error(
                "You don't have any storage accounts with claimable stake."
            );
        }

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message: "Which storage account do you want to reduce storage on?",
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
            return log.error(
                "You must pick a storage account to reduce storage on."
            );
        }
        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        const txnSpinner = ora(
            "Sending claim stake transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                const claimStake = await drive.claimStake(storageAccount, "v1");
                log.info(claimStake);
            }
            if (storageAccountType === "V2") {
                const claimStake = await drive.claimStake(storageAccount, "v2");
                log.info(claimStake);
            }
            txnSpinner.succeed(
                `You have claimed ${formattedAccount.unstakeTokenAccountBalance.value.uiAmount} $SHDW from your storage account ${storageAccount}.`
            );
            return;
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            console.log(e);
            return;
        }
        return;
    });

programCommand("redeem-file-account-rent")
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
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;

        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
        );

        formattedAccounts = formattedAccounts.sort(
            sortByProperty("accountCounterSeed")
        );

        const pickedAccount = await prompts({
            type: "select",
            name: "option",
            message:
                "Which storage account do you want to redeem all file rent from?",
            choices: formattedAccounts.map((acc: any) => {
                return {
                    title: `${acc.identifier} - ${acc.pubkey.toString()} - ${
                        acc.storageAvailable
                    } remaining`,
                };
            }),
        });

        if (typeof pickedAccount.option === "undefined") {
            log.error(
                "You must pick a storage account to redeem file rent from."
            );
            return;
        }

        // Get current storage and user funds
        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const agrees = await prompts({
            type: "confirm",
            name: "confirm",
            message: `Warning: this will delete all on-chain file accounts associated with the storage account ${storageAccount.toString()} in order to reclaim the SOL rent. Your data/files will not be removed from Shadow Drive.`,
            initial: false,
        });
        if (!agrees.confirm) {
            return log.error("You must confirm before moving forward.");
        }
        const onchainStorageAccountInfo =
            await programClient.account.storageAccount.fetch(storageAccount);
        const numberOfFiles = onchainStorageAccountInfo.initCounter;
        let filePubkeys: PublicKey[] = [];
        for (let i = 0; i < numberOfFiles; i++) {
            const fileSeed = new anchor.BN(i);
            let [file] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    storageAccount.toBytes(),
                    fileSeed.toTwos(64).toArrayLike(Buffer, "le", 4),
                ],
                programClient.programId
            );
            let fileAccountInfo = await connection.getAccountInfo(file);
            if (fileAccountInfo) {
                filePubkeys.push(file);
            }
        }
        const progress = new cliProgress.SingleBar({
            format: "Progress | {bar} | {percentage}% || {value}/{total} file accounts closed",
            barCompleteChar: "\u2588",
            barIncompleteChar: "\u2591",
            hideCursor: true,
        });
        progress.start(filePubkeys.length, 0);
        await Promise.all(
            filePubkeys.map(async (pubkey) => {
                try {
                    const redeem = await drive.redeemRent(
                        storageAccount,
                        pubkey
                    );
                    log.info(redeem);
                    progress.increment(1);
                } catch (e) {
                    log.error("Error with transaction, see below for details");
                    log.error(e);
                }
            })
        );
        progress.stop();
        log.info(
            `Successfully reclaimed rent from all file accounts in storage account ${storageAccount.toString()}`
        );
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
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;

        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        log.info(`Picked account ${storageAccount}`);
        const txnSpinner = ora(
            "Sending refresh stake transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            if (storageAccountType === "V1") {
                const claimStake = await drive.refreshStake(
                    storageAccount,
                    "v1"
                );
                log.info(claimStake);
            }
            if (storageAccountType === "V2") {
                const claimStake = await drive.refreshStake(
                    storageAccount,
                    "v2"
                );
                log.info(claimStake);
            }
            txnSpinner.succeed(
                `You have refreshed stake for storage account ${storageAccount}.`
            );
            return;
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            return;
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
        const [programClient, provider] = getAnchorEnvironment(
            keypair,
            connection
        );
        const userInfoAccount = await connection.getAccountInfo(userInfo);
        if (userInfoAccount === null) {
            return log.error(
                "You have not created a storage account on Shadow Drive yet. Please see the 'create-storage-account' command to get started."
            );
        }

        let userInfoData = await programClient.account.userInfo.fetch(userInfo);

        let numberOfStorageAccounts = userInfoData.accountCounter - 1;

        let [formattedAccounts] = await getFormattedStorageAccounts(
            keypair.publicKey,
            numberOfStorageAccounts
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
            return;
        }

        const storageAccount = formattedAccounts[pickedAccount.option].pubkey;
        const formattedAccount = formattedAccounts[pickedAccount.option];
        const storageAccountType = await validateStorageAccount(
            storageAccount,
            connection
        );
        if (!storageAccountType || storageAccountType === null) {
            return log.error(
                `Storage account ${storageAccount.toString()} is not a valid Shadow Drive Storage Account.`
            );
        }
        log.info(`Picked account ${storageAccount}`);
        const txnSpinner = ora(
            "Sending top up transaction request. Subject to solana traffic conditions (w/ 120s timeout)."
        ).start();
        try {
            const claimStake = await drive.topUp(
                storageAccount,
                options.amount * 10 ** 9
            );
            log.info(claimStake);
            txnSpinner.succeed(
                `You have added stake for storage account ${storageAccount}.`
            );
            return;
        } catch (e) {
            txnSpinner.fail(
                "Error sending transaction. See below for details:"
            );
            return;
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

program.parse(process.argv);
