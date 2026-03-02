/**
 * Gas Estimation Agent
 * Author: @lustsazeus
 * 
 * A PayPol agent for comparing real-time gas costs across multiple chains
 * Supports: Tempo L1, Ethereum, Arbitrum, Base
 */

import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';
import { PayPolAgent, JobRequest, JobResult } from 'paypol-sdk';

// Chain configurations
const CHAINS = {
  tempo: {
    id: 42431,
    name: 'Tempo L1',
    rpc: process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz',
    explorer: 'https://explore.tempo.xyz',
    hasZeroGas: true,
  },
  ethereum: {
    id: 1,
    name: 'Ethereum',
    rpc: process.env.ETHEREUM_RPC_URL ?? 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io',
    hasZeroGas: false,
  },
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    rpc: process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    hasZeroGas: false,
  },
  base: {
    id: 8453,
    name: 'Base',
    rpc: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    hasZeroGas: false,
  },
};

// ETH/USD price feed (simplified - in production, use oracle)
const ETH_USDPrice = parseFloat(process.env.ETH_USD_PRICE ?? '3500');

// Gas estimation helper
interface GasEstimate {
  chain: string;
  chainId: number;
  gasPrice: string;
  gasPriceWei: bigint;
  cost: string;
  costUsd: number;
  speed: string;
  available: boolean;
  error?: string;
}

// Get gas estimate for a chain
async function getGasEstimate(chainKey: keyof typeof CHAINS, operation: string): Promise<GasEstimate> {
  const chain = CHAINS[chainKey];
  
  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    
    // Check if chain has zero gas (like Tempo)
    if (chain.hasZeroGas) {
      return {
        chain: chain.name,
        chainId: chain.id,
        gasPrice: '0 gwei',
        gasPriceWei: 0n,
        cost: '$0.00',
        costUsd: 0,
        speed: '2s',
        available: true,
      };
    }
    
    // Get current gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasPriceGwei = ethers.formatUnits(gasPrice, 'gwei');
    
    // Estimate gas for operation
    let gasLimit: bigint;
    switch (operation.toLowerCase()) {
      case 'erc-20 transfer':
        gasLimit = 65000n;
        break;
      case 'contract deploy':
        gasLimit = 2000000n;
        break;
      case 'simple transfer':
      default:
        gasLimit = 21000n;
    }
    
    const costWei = gasPrice * gasLimit;
    const costEth = ethers.formatEther(costWei);
    const costUsd = parseFloat(costEth) * ETH_USDPrice;
    
    // Determine speed based on chain
    let speed: string;
    if (chainKey === 'ethereum') {
      speed = '12s';
    } else if (chainKey === 'arbitrum' || chainKey === 'base') {
      speed = '2s';
    } else {
      speed = '3s';
    }
    
    return {
      chain: chain.name,
      chainId: chain.id,
      gasPrice: `${parseFloat(gasPriceGwei).toFixed(4)} gwei`,
      gasPriceWei: gasPrice,
      cost: `$${costUsd.toFixed(4)}`,
      costUsd,
      speed,
      available: true,
    };
  } catch (error: any) {
    return {
      chain: chain.name,
      chainId: chain.id,
      gasPrice: 'N/A',
      gasPriceWei: 0n,
      cost: 'N/A',
      costUsd: 0,
      speed: 'N/A',
      available: false,
      error: error.message,
    };
  }
}

// Parse operation type from prompt
function parseOperation(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes('erc-20') || lower.includes('token')) {
    return 'ERC-20 Transfer';
  }
  if (lower.includes('contract') || lower.includes('deploy')) {
    return 'Contract Deploy';
  }
  return 'Simple Transfer';
}

// Create the gas estimation agent
const gasEstimatorAgent = new PayPolAgent({
  id: 'gas-estimator',
  name: 'Multi-chain Gas Estimator',
  description: 'Compare real-time gas costs across Tempo L1, Ethereum, Arbitrum, and Base. Get cost estimates for different operations and recommendations for the cheapest chain.',
  category: 'defi',
  version: '1.0.0',
  price: 5,
  capabilities: [
    'gas-estimation',
    'multi-chain',
    'cost-comparison',
    'read-only',
  ],
  author: 'lustsazeus',
});

// Set up job handler
gasEstimatorAgent.onJob(async (job: JobRequest): Promise<JobResult> => {
  const start = Date.now();
  console.log(`[gas-estimator] Job ${job.jobId}: ${job.prompt}`);

  try {
    const prompt = job.prompt.toLowerCase();
    const payload = job.payload || {};
    
    // Get operation type
    const operation = parseOperation(job.prompt);
    
    // Get estimates for all chains in parallel
    const results: [GasEstimate, GasEstimate, GasEstimate, GasEstimate] = await Promise.all([
      getGasEstimate('tempo', operation),
      getGasEstimate('ethereum', operation),
      getGasEstimate('arbitrum', operation),
      getGasEstimate('base', operation),
    ]) as [GasEstimate, GasEstimate, GasEstimate, GasEstimate];
    
    const estimates = [...results];
    
    // Filter available chains and sort by cost
    const availableEstimates = estimates
      .filter(e => e.available)
      .sort((a, b) => a.costUsd - b.costUsd);
    
    // Generate recommendation
    let recommendation = '';
    if (availableEstimates.length > 0) {
      const cheapest = availableEstimates[0];
      if (cheapest.costUsd === 0) {
        recommendation = `${cheapest.chain} has zero gas fees with fast finality.`;
      } else {
        recommendation = `${cheapest.chain} is the cheapest at ${cheapest.cost}. `;
        if (availableEstimates.length > 1) {
          const second = availableEstimates[1];
          recommendation += `Consider ${second.chain} (${second.cost}) as an alternative.`;
        }
      }
    } else {
      recommendation = 'Unable to get gas estimates from any chain. Please check RPC connections.';
    }
    
    // Check if this is a specific chain query
    let filteredEstimates = estimates;
    if (prompt.includes('tempo')) {
      filteredEstimates = estimates.filter(e => e.chain.includes('Tempo'));
    } else if (prompt.includes('ethereum') || prompt.includes('eth')) {
      filteredEstimates = estimates.filter(e => e.chain.includes('Ethereum'));
    } else if (prompt.includes('arbitrum')) {
      filteredEstimates = estimates.filter(e => e.chain.includes('Arbitrum'));
    } else if (prompt.includes('base')) {
      filteredEstimates = estimates.filter(e => e.chain.includes('Base'));
    }
    
    // Format response
    const resultEstimates = filteredEstimates.map(e => ({
      chain: e.chain,
      gasPrice: e.gasPrice,
      cost: e.cost,
      speed: e.speed,
      explorer: CHAINS[Object.keys(CHAINS).find(k => CHAINS[k as keyof typeof CHAINS].name === e.chain) as keyof typeof CHAINS]?.explorer,
    }));
    
    return {
      jobId: job.jobId,
      agentId: job.agentId,
      status: 'success',
      result: {
        action: 'gas_estimate',
        operation,
        estimates: resultEstimates,
        recommendation,
        cached: false,
        ttl: '15s',
        timestamp: new Date().toISOString(),
      },
      executionTimeMs: Date.now() - start,
      timestamp: Date.now(),
    };
    
  } catch (err: any) {
    return {
      jobId: job.jobId,
      agentId: job.agentId,
      status: 'error',
      error: err.message ?? String(err),
      executionTimeMs: Date.now() - start,
      timestamp: Date.now(),
    };
  }
});

// Express server setup
const app = express();
app.use(express.json());

// Agent routes
app.get('/manifest', (_req, res) => res.json(gasEstimatorAgent.toManifest()));
app.post('/execute', async (req, res) => {
  const job: JobRequest = {
    jobId: req.body.jobId ?? require('crypto').randomUUID(),
    agentId: 'gas-estimator',
    prompt: req.body.prompt ?? '',
    payload: req.body.payload,
    callerWallet: req.body.callerWallet ?? '',
    timestamp: Date.now(),
  };
  try {
    const handler = (gasEstimatorAgent as any).jobHandler;
    const result = await handler(job);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', agent: 'gas-estimator' }));

const PORT = Number(process.env.AGENT_PORT ?? 3011);
app.listen(PORT, () => {
  console.log(`[gas-estimator] Multi-chain Gas Estimator running on port ${PORT}`);
  console.log(`  Agent: gas-estimator`);
  console.log(`  Author: @lustsazeus`);
});

export { gasEstimatorAgent };
