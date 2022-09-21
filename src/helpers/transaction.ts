/**
  Credit to https://github.com/StrataFoundation/strata/tree/master/packages/spl-utils for the basis of this code.

  Modificationsn were made to meet our specific use-case to help with errors and stability.
*/

import {
  Commitment,
  Connection,
  RpcResponseAndContext,
  SendOptions,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import log from "loglevel";

function sleep(ms: number): Promise<any> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUnixTime(): number {
  return new Date().valueOf() / 1000;
}

export const awaitTransactionSignatureConfirmation = async (
  txid: TransactionSignature,
  timeout: number,
  connection: Connection,
  commitment: Commitment = "recent",
  queryStatus = false
): Promise<SignatureStatus | null | void> => {
  let done = false;
  let status: SignatureStatus | null | void = {
    slot: 0,
    confirmations: 0,
    err: null,
  };
  let subId = 0;
  status = await new Promise(async (resolve, reject) => {
    let timer: any = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      log.debug("Rejecting for timeout...");
      reject({ timeout: true });
    }, timeout);
    try {
      log.debug("COMMIMENT", commitment);
      subId = connection.onSignature(
        txid,
        (result: any, context: any) => {
          done = true;
          status = {
            err: result.err,
            slot: context.slot,
            confirmations: 0,
          };
          if (result.err) {
            log.debug("Rejected via websocket", result.err);
            reject(status);
          } else {
            log.debug("Resolved via websocket", result);
            resolve(status);
          }
        },
        commitment
      );
    } catch (e) {
      done = true;
      console.error("WS error in setup", txid, e);
    }
    while (!done && queryStatus) {
      // eslint-disable-next-line no-loop-func
      (async () => {
        try {
          const signatureStatuses = await connection.getSignatureStatuses([
            txid,
          ]);
          status = signatureStatuses && signatureStatuses.value[0];
          if (!done) {
            if (!status) {
              log.debug("REST null result for", txid, status);
              if (timer === null) {
                timer = setTimeout(() => {
                  if (done) {
                    return;
                  }
                  done = true;
                  console.log("Rejecting for timeout...");
                  reject({ timeout: true });
                }, timeout);
              }
            } else if (status.err) {
              log.debug("REST error for", txid, status);
              done = true;
              reject(status.err);
            } else if (!status.confirmations && !status.confirmationStatus) {
              log.debug("REST no confirmations for", txid, status);
            } else {
              log.debug("REST confirmation for", txid, status);
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              if (
                !status.confirmationStatus ||
                status.confirmationStatus == commitment
              ) {
                done = true;
                resolve(status);
              }
            }
          }
        } catch (e) {
          if (!done) {
            log.debug("REST connection error: txid", txid, e);
          }
        }
      })();
      await sleep(2000);
    }
  });

  done = true;
  log.debug("Returning status ", status);
  return status;
};

async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching
  );

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString("base64");
  const config: any = { encoding: "base64", commitment };
  const args = [encodedTransaction, config];

  // @ts-ignore
  const res = await connection._rpcRequest("simulateTransaction", args);
  if (res.error) {
    throw new Error("failed to simulate transaction: " + res.error.message);
  }
  return res.result;
}

const DEFAULT_TIMEOUT = 3 * 60 * 1000; // 3 minutes
/*
    Original comment from Strata:
    -----------------------------------------------
    A validator has up to 120s to accept the transaction and send it into a block.
    If it doesn’t happen within that timeframe, your transaction is dropped and you’ll need 
    to send the transaction again. You can get the transaction signature and periodically 
    Ping the network for that transaction signature. If you never get anything back, 
    that means it’s definitely been dropped. If you do get a response back, you can keep pinging 
    until it’s gone to a confirmed status to move on.
  */
export async function sendAndConfirm(
  connection: Connection,
  txn: Buffer,
  sendOptions: SendOptions,
  commitment: Commitment,
  timeout = DEFAULT_TIMEOUT
): Promise<{ txid: string }> {
  try {
    let done = false;
    let slot = 0;
    const txid = await connection.sendRawTransaction(txn, sendOptions);
    const startTime = getUnixTime();
    try {
      const confirmation = await awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        connection,
        commitment,
        true
      );

      if (!confirmation)
        throw new Error("Timed out awaiting confirmation on transaction");

      if (confirmation.err) {
        const tx = await connection.getTransaction(txid);
        console.error(tx?.meta?.logMessages?.join("\n"));
        console.error(confirmation.err);
        throw new Error("Transaction failed: Custom instruction error");
      }

      slot = confirmation?.slot || 0;
    } catch (err: any) {
      console.error("Timeout Error caught", err);
      if (err.timeout) {
        throw new Error("Timed out awaiting confirmation on transaction");
      }
      let simulateResult: SimulatedTransactionResponse | null = null;
      try {
        simulateResult = (
          await simulateTransaction(connection, Transaction.from(txn), "single")
        ).value;
      } catch (e) {}
      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          console.error(simulateResult.logs.join("\n"));
        }
      }

      if (err.err) {
        throw err.err;
      }

      throw err;
    } finally {
      done = true;
    }

    log.debug("Latency", txid, getUnixTime() - startTime);

    return { txid };
  } catch (e) {
    throw new Error(e);
  }
}
