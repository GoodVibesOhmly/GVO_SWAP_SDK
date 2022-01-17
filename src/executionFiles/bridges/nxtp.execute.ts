import {
  HistoricalTransaction,
  NxtpSdk,
  NxtpSdkBase,
  NxtpSdkEvents,
  ReceiverTransactionPreparedPayload,
} from '@connext/nxtp-sdk'
import { TransactionResponse } from '@ethersproject/abstract-provider'
import { constants, ethers, utils, Signer } from 'ethers'

import Lifi from '../../Lifi'
import {
  ChainId,
  ExecuteCrossParams,
  Execution,
  getChainById,
  isLifiStep,
  isSwapStep,
  Process,
  Chain,
  Step,
  Action,
} from '../../types'
import { personalizeStep } from '../../utils'
import { getRpcProvider, getRpcUrls } from '../../connectors'
import { checkAllowance } from '../allowance.execute'
import nxtp from './nxtp'
import { getDeployedTransactionManagerContract } from '@connext/nxtp-sdk/dist/transactionManager/transactionManager'
import { signFulfillTransactionPayload } from '@connext/nxtp-sdk/dist/utils'
import { balanceCheck } from '../balanceCheck.execute'
import { parseWalletError } from '../../utils/parseError'
import StatusManager from '../../StatusManager'
import { LifiErrorCodes, RPCError } from '../../utils/errors'

export class NXTPExecutionManager {
  shouldContinue = true

  setShouldContinue = (val: boolean): void => {
    this.shouldContinue = val
  }

  execute = async ({
    signer,
    step,
    statusManager,
    hooks,
  }: ExecuteCrossParams): Promise<Execution> => {
    const { action, estimate } = step
    step.execution = statusManager.initExecutionObject(step)
    const fromChain = getChainById(action.fromChainId)
    const toChain = getChainById(action.toChainId)
    const oldCrossProcess = step.execution.process.find(
      (p) => p.id === 'crossProcess'
    )
    const transactionId = step.id

    // STEP 0: Check Allowance ////////////////////////////////////////////////
    if (action.fromToken.address !== constants.AddressZero) {
      // Check Token Approval only if fromToken is not the native token => no approval needed in that case
      if (!this.shouldContinue) return step.execution
      await checkAllowance(
        signer,
        step,
        fromChain,
        action.fromToken,
        action.fromAmount,
        estimate.approvalAddress,
        statusManager,
        true
      )
    }

    // STEP 1: Get Public Key ////////////////////////////////////////////////
    // check that a public key hook is given and that step allows encryption
    if (
      hooks.getPublicKeyHook &&
      isLifiStep(step) &&
      isSwapStep(step.includedSteps[step.includedSteps.length - 1]) &&
      (!oldCrossProcess || !oldCrossProcess.txHash)
    ) {
      // -> set step.execution
      const keyProcess = statusManager.findOrCreateProcess(
        'publicKey',
        step,
        'Provide Public Key',
        {
          status: 'ACTION_REQUIRED',
        }
      )
      if (!this.shouldContinue) return step.execution
      // -> request key
      try {
        const encryptionPublicKey = await hooks.getPublicKeyHook()
        // store key
        if (!step.estimate.data) step.estimate.data = {}
        step.estimate.data.encryptionPublicKey = encryptionPublicKey
      } catch (e: any) {
        statusManager.updateProcess(step, keyProcess.id, 'FAILED', {
          errorMessage: e.message,
        })
        statusManager.updateExecution(step, 'FAILED')
        throw e
      }
      // -> set step.execution
      statusManager.updateProcess(step, keyProcess.id, 'DONE')
    }

    // STEP 2: Get Transaction ////////////////////////////////////////////////
    const crossProcess = statusManager.findOrCreateProcess(
      'crossProcess',
      step,
      'Prepare Transaction'
    )
    if (crossProcess.status !== 'DONE') {
      let tx: TransactionResponse
      try {
        if (crossProcess.txHash) {
          // -> restore existing tx
          statusManager.updateProcess(step, crossProcess.id, 'PENDING')
          const fromProvider = getRpcProvider(step.action.fromChainId)
          tx = await fromProvider.getTransaction(crossProcess.txHash)
        } else {
          // Check balance
          await balanceCheck(signer, step)

          // Prepare transaction
          const personalizedStep = await personalizeStep(signer, step)
          const updatedStep = await Lifi.getStepTransaction(personalizedStep)
          // update step
          Object.assign(step, updatedStep)
          if (!step.transactionRequest) {
            statusManager.updateProcess(step, crossProcess.id, 'FAILED', {
              errorMessage: 'Unable to prepare Transaction',
            })
            statusManager.updateExecution(step, 'FAILED')
            throw crossProcess.errorMessage
          }

          // STEP 3: Send Transaction ///////////////////////////////////////////////
          statusManager.updateProcess(step, crossProcess.id, 'ACTION_REQUIRED')
          if (!this.shouldContinue) return step.execution

          tx = await signer.sendTransaction(step.transactionRequest)

          // STEP 4: Wait for Transaction ///////////////////////////////////////////
          statusManager.updateProcess(step, crossProcess.id, 'PENDING', {
            txHash: tx.hash,
            txLink: fromChain.metamask.blockExplorerUrls[0] + 'tx/' + tx.hash,
          })
        }
      } catch (e) {
        const error = parseWalletError(e)
        statusManager.updateProcess(step, crossProcess.id, 'FAILED', {
          errorMessage: error.message,
          errorCode: error.code,
        })
        statusManager.updateExecution(step, 'FAILED')
        throw error
      }

      try {
        await tx.wait()
      } catch (e: any) {
        if (e.code === 'TRANSACTION_REPLACED' && e.replacement) {
          statusManager.updateProcess(step, crossProcess.id, 'PENDING', {
            txHash: e.replacement.hash,
            txLink:
              fromChain.metamask.blockExplorerUrls[0] +
              'tx/' +
              e.replacement.hash,
          })
        } else {
          const error = parseWalletError(e)
          statusManager.updateProcess(step, crossProcess.id, 'FAILED', {
            errorMessage: error.message,
            errorCode: error.code,
          })
          statusManager.updateExecution(step, 'FAILED')
          throw error
        }
      }

      statusManager.updateProcess(step, crossProcess.id, 'DONE', {
        message: 'Transfer started: ',
      })
    }

    // STEP 5: Wait for ReceiverTransactionPrepared //////////////////////////////////////
    const claimProcess = statusManager.findOrCreateProcess(
      'claimProcess',
      step,
      'Wait for bridge'
    )
    // reset previous process
    statusManager.updateProcess(step, claimProcess.id, 'PENDING', {
      message: 'Wait for bridge',
    })

    // init sdk
    const { sdk: nxtpSDK, sdkBase: nxtpBaseSDK } = await this.initNxtpSdk(
      signer,
      action
    )

    const transactionPreparedPromise =
      this.createWaitForReceiverTransactionPreparedPromise(
        nxtpSDK,
        nxtpBaseSDK,
        transactionId
      ).catch((e) => {
        statusManager.updateProcess(step, claimProcess.id, 'FAILED', {
          errorMessage: e.message,
          errorCode: e.code,
        })
        statusManager.updateExecution(step, 'FAILED')
        throw e
      })

    // while we wait for the ReceiverTransactionPrepared event, we already check if we are done and could abort here
    const historicalTransaction = await this.searchHistoricalTransaction(
      nxtpBaseSDK,
      transactionId
    )
    if (historicalTransaction) {
      return this.handleFoundTransaction(
        nxtpSDK,
        statusManager,
        historicalTransaction,
        step,
        claimProcess,
        toChain
      )
    }

    // STEP 6: Wait for signature //////////////////////////////////////////////////////////
    let calculatedRelayerFee
    let signature
    try {
      if (step.estimate.data?.relayFee) {
        calculatedRelayerFee = step.estimate.data.relayFee
      } else {
        calculatedRelayerFee = await nxtp.calculateRelayerFee(nxtpBaseSDK, {
          sendingChainId: action.fromChainId,
          sendingAssetId: action.fromToken.address,
          receivingChainId: action.toChainId,
          receivingAssetId: action.toToken.address,
          // ignore call data, because we are passing a custom relayFee in these cases
          callData: '0x',
          callTo: ethers.constants.AddressZero,
        })
      }

      const receivingChainTxManager = getDeployedTransactionManagerContract(
        action.toChainId
      )
      if (!receivingChainTxManager) {
        statusManager.updateProcess(step, claimProcess.id, 'FAILED', {
          errorMessage: `No TransactionManager definded for chain: ${action.toChainId}`,
        })
        statusManager.updateExecution(step, 'FAILED')
        nxtpSDK.removeAllListeners()
        throw new Error(
          `No TransactionManager definded for chain: ${action.toChainId}`
        )
      }

      statusManager.updateProcess(step, claimProcess.id, 'ACTION_REQUIRED', {
        message: 'Provide Signature',
      })

      if (!this.shouldContinue) {
        nxtpSDK.removeAllListeners()
        return step.execution
      }

      signature = await signFulfillTransactionPayload(
        transactionId,
        calculatedRelayerFee,
        action.toChainId,
        receivingChainTxManager.address,
        signer
      )
    } catch (e: any) {
      statusManager.updateProcess(step, claimProcess.id, 'FAILED', {
        errorMessage: e.message,
      })
      statusManager.updateExecution(step, 'FAILED')
      nxtpSDK.removeAllListeners()
      throw e
    }

    // STEP 7: Wait for Bridge //////////////////////////////////////////////////////////

    statusManager.updateProcess(step, claimProcess.id, 'PENDING', {
      message: 'Wait for bridge (1-5 min)',
    })

    const preparedTransaction = await transactionPreparedPromise // exceptions need to be caught earlier since they might be thrown before await is called here
    if (this.isHistoricalTransaction(preparedTransaction)) {
      return this.handleFoundTransaction(
        nxtpSDK,
        statusManager,
        preparedTransaction,
        step,
        claimProcess,
        toChain
      )
    }

    // STEP 8: Decrypt CallData //////////////////////////////////////////////////////////
    let callData = '0x'
    // Does it cointain callData?
    if (preparedTransaction.txData.callDataHash !== utils.keccak256(callData)) {
      if (
        step.estimate.data.callData &&
        preparedTransaction.txData.callDataHash ===
          utils.keccak256(step.estimate.data.callData)
      ) {
        // Use cached call data
        callData = step.estimate.data.callData
      } else if (
        preparedTransaction.txData.callDataHash ===
        utils.keccak256(preparedTransaction.encryptedCallData)
      ) {
        // Call data was passed unencrypted
        callData = preparedTransaction.encryptedCallData
      } else if (hooks.decryptHook) {
        // Tigger hock to decrypt data
        statusManager.updateProcess(step, claimProcess.id, 'ACTION_REQUIRED', {
          message: 'Decrypt transaction data',
        })
        if (!this.shouldContinue) {
          nxtpSDK.removeAllListeners()
          return step.execution
        }

        try {
          callData = await hooks.decryptHook(
            preparedTransaction.encryptedCallData
          )
        } catch (e: any) {
          statusManager.updateProcess(step, claimProcess.id, 'FAILED', {
            errorMessage: e.message,
          })
          statusManager.updateExecution(step, 'FAILED')
          nxtpSDK.removeAllListeners()
          throw e
        }
      } else {
        // Continue without call data
        console.warn(
          'CallData not forwared because no decryptHook is set to decypt it.'
        )
      }
    }

    // STEP 9: Wait for Claim //////////////////////////////////////////////////////////
    statusManager.updateProcess(step, claimProcess.id, 'PENDING', {
      message: 'Waiting for claim (1-5 min)',
    })

    try {
      const response = await nxtpBaseSDK.fulfillTransfer(
        preparedTransaction,
        signature,
        callData,
        calculatedRelayerFee,
        true
      )

      statusManager.updateProcess(step, claimProcess.id, 'DONE', {
        txHash: response.transactionResponse?.transactionHash,
        txLink:
          toChain.metamask.blockExplorerUrls[0] +
          'tx/' +
          response.transactionResponse?.transactionHash,
        message: 'Funds Received:',
      })
    } catch (e: any) {
      if (e.message) claimProcess.errorMessage = e.message
      nxtpSDK.removeAllListeners()
      statusManager.updateProcess(step, claimProcess.id, 'FAILED', {
        errorMessage: e.message,
      })
      statusManager.updateExecution(step, 'FAILED')
      throw e
    }

    const provider = getRpcProvider(step.action.toChainId)
    const claimTx = await provider.getTransaction(claimProcess.txHash)
    const receipt = await provider.waitForTransaction(claimProcess.txHash)

    // wait until balance rpc contains block number >= the claim block number to make sure the funds are available on the users wallet
    let balanceBlockNumber = 0
    const walletAddress = await signer.getAddress()
    do {
      // get balance
      const tokenAmount = await Lifi.getTokenBalance(
        walletAddress,
        step.action.toToken
      )
      if (tokenAmount && tokenAmount.blockNumber) {
        balanceBlockNumber = tokenAmount.blockNumber
      }
    } while (balanceBlockNumber < receipt.blockNumber)

    const parsedReceipt = await nxtp.parseReceipt(
      await signer.getAddress(),
      action.toToken.address,
      claimTx,
      receipt
    )

    // status.gasUsed = parsedReceipt.gasUsed
    //statusManager.updateProcess(step, claimProcess, 'DONE')

    statusManager.updateExecution(step, 'DONE', {
      fromAmount: estimate.fromAmount,
      toAmount: parsedReceipt.toAmount,
    })

    // DONE
    nxtpSDK.removeAllListeners()
    return step.execution
  }

  private initNxtpSdk = (signer: Signer, action: Action) => {
    const crossableChains = [ChainId.ETH, action.fromChainId, action.toChainId]
    const chainProviders = getRpcUrls(crossableChains)
    return nxtp.setup(signer, chainProviders)
  }

  private searchHistoricalTransaction = async (
    nxtpBaseSDK: NxtpSdkBase,
    transactionId: string
  ): Promise<HistoricalTransaction | undefined> => {
    // check active transactions. this is more efficient than querying historical transactions. If there is an active one we don't have to query the historical ones yet
    const transactions = await nxtpBaseSDK
      .getActiveTransactions()
      .catch(() => [])
    const activeTransaction = transactions.find(
      (transfer) =>
        transfer.crosschainTx.invariant.transactionId === transactionId
    )

    if (!activeTransaction) {
      // check if already done?
      const historicalTransactions = await nxtpBaseSDK
        .getHistoricalTransactions()
        .catch(() => [])
      const historicTransaction = historicalTransactions.find(
        (transfer) =>
          transfer.crosschainTx.invariant.transactionId === transactionId
      )

      return historicTransaction
    }
  }

  private handleFoundTransaction = (
    nxtpSDK: NxtpSdk,
    statusManager: StatusManager,
    transaction: HistoricalTransaction,
    step: Step,
    process: Process,
    toChain: Chain
  ): Execution => {
    switch (transaction.status) {
      case 'CANCELLED':
        statusManager.updateProcess(step, process.id, 'CANCELLED')
        break
      case 'FULFILLED':
        statusManager.updateProcess(step, process.id, 'DONE', {
          message: 'Funds received: ',
          txHash: transaction.fulfilledTxHash,
          txLink:
            toChain.metamask.blockExplorerUrls[0] +
            'tx/' +
            transaction.fulfilledTxHash,
        })

        statusManager.updateExecution(step, 'DONE', {
          fromAmount: step.estimate.fromAmount,
          toAmount: step.estimate.toAmount,
        })

        break

      default:
        debugger
        nxtpSDK.removeAllListeners()
        throw new Error(`Transaction with unknown state ${transaction.status}`)
    }

    nxtpSDK.removeAllListeners()
    return step.execution!
  }

  private isHistoricalTransaction = (
    transaction: any
  ): transaction is HistoricalTransaction => transaction.status

  private createWaitForReceiverTransactionPreparedPromise = (
    nxtpSDK: NxtpSdk,
    nxtpBaseSDK: NxtpSdkBase,
    transactionId: string
  ): Promise<ReceiverTransactionPreparedPayload | HistoricalTransaction> => {
    const retryWrapper = (
      retryCounter = 0
    ): Promise<ReceiverTransactionPreparedPayload | HistoricalTransaction> =>
      nxtpSDK
        .waitFor(
          NxtpSdkEvents.ReceiverTransactionPrepared,
          10 * 60 * 1000, // = 10 minutes
          (data) => data.txData.transactionId === transactionId
        )
        .catch(async (e: any) => {
          if (e.message.includes('Evt timeout')) {
            console.debug('NXTP timed out')

            // maybe we are already done? Search for the transaction!
            const foundTransaction = await this.searchHistoricalTransaction(
              nxtpBaseSDK,
              transactionId
            )

            if (foundTransaction) {
              // we cannot handle the transaction here due to the function scope, need to exit the function and let the callee deal with it
              return foundTransaction
            }

            if (retryCounter < 3) {
              console.debug('Retrying wait for ReceiverTransactionPrepared')
              return retryWrapper(retryCounter + 1)
            } else {
              throw new RPCError(
                LifiErrorCodes.timeout,
                'NXTP receiver transaction timed out',
                e.stack
              )
            }
          } else {
            throw parseWalletError(e)
          }
        })

    return retryWrapper()
  }
}
