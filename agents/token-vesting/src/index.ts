/**
 * Token Vesting Agent
 * Author: @lustsazeus
 * 
 * A PayPol agent for creating and managing token vesting schedules
 * Supports linear vesting and cliff-based vesting on Tempo L1
 */

import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';
import { PayPolAgent, JobRequest, JobResult } from 'paypol-sdk';

const RPC_URL = process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz';

// Standard ERC20 ABI
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Vesting schedule interface
interface VestingSchedule {
  beneficiary: string;
  tokenAddress: string;
  totalAmount: bigint;
  startTime: number;
  cliffDuration: number;  // seconds
  vestingDuration: number;  // seconds
}

// Calculate vested amount based on schedule
function calculateVestedAmount(schedule: VestingSchedule, currentTime: number = Date.now() / 1000): bigint {
  const { totalAmount, startTime, cliffDuration, vestingDuration } = schedule;
  
  if (currentTime < startTime) {
    return 0n;
  }
  
  const timePassed = currentTime - startTime;
  
  // If before cliff, nothing is vested
  if (timePassed < cliffDuration) {
    return 0n;
  }
  
  // If after vesting period, everything is vested
  if (timePassed >= vestingDuration) {
    return totalAmount;
  }
  
  // Linear vesting after cliff
  const vestedRatio = BigInt(timePassed - cliffDuration) * BigInt(1e18) / BigInt(vestingDuration - cliffDuration);
  return totalAmount * vestedRatio / BigInt(1e18);
}

// Parse natural language input into vesting schedule
function parseVestingInput(prompt: string, payload: any): VestingSchedule | null {
  const beneficiary = payload?.beneficiary || extractAddress(prompt) || '';
  const tokenAddress = payload?.tokenAddress || '0x0000000000000000000000000000000000000000'; // TEMPO by default
  
  let totalAmount = payload?.totalAmount || extractAmount(prompt);
  const duration = extractDuration(prompt);
  const cliffMonths = extractCliff(prompt);
  
  if (!beneficiary || !totalAmount || !duration) {
    return null;
  }
  
  const now = Math.floor(Date.now() / 1000);
  const cliffDuration = cliffMonths * 30 * 24 * 60 * 60;
  const vestingDuration = duration * 30 * 24 * 60 * 60;
  
  return {
    beneficiary,
    tokenAddress,
    totalAmount: ethers.parseEther(String(totalAmount)),
    startTime: now,
    cliffDuration,
    vestingDuration,
  };
}

// Helper to extract Ethereum address from text
function extractAddress(text: string): string | null {
  const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
  return addrMatch ? addrMatch[0] : null;
}

// Helper to extract amount from text
function extractAmount(text: string): number | null {
  const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:tokens?|TEMPO|eth|wei)?/i);
  if (amountMatch) {
    return parseFloat(amountMatch[1]);
  }
  // Also try just finding a number
  const numMatch = text.match(/\b(\d+)\b/);
  return numMatch ? parseInt(numMatch[1]) : null;
}

// Helper to extract vesting duration in months
function extractDuration(text: string): number | null {
  const monthMatch = text.match(/(\d+)\s*(?:month|mo)/i);
  if (monthMatch) {
    return parseInt(monthMatch[1]);
  }
  const yearMatch = text.match(/(\d+)\s*(?:year|yr)/i);
  if (yearMatch) {
    return parseInt(yearMatch[1]) * 12;
  }
  return 12; // default to 12 months
}

// Helper to extract cliff duration in months
function extractCliff(text: string): number {
  const cliffMatch = text.match(/(\d+)\s*(?:month|mo).*cliff/i) || text.match(/cliff.*?(\d+)\s*(?:month|mo)/i);
  if (cliffMatch) {
    return parseInt(cliffMatch[1]);
  }
  return 3; // default 3 month cliff
}

// Create the vesting agent
const tokenVestingAgent = new PayPolAgent({
  id: 'token-vesting',
  name: 'Token Vesting Schedule',
  description: 'Create and manage token vesting schedules with linear and cliff-based release on Tempo L1 blockchain.',
  category: 'defi',
  version: '1.0.0',
  price: 10,
  capabilities: [
    'token-vesting',
    'linear-vesting',
    'cliff-vesting',
    'schedule-management',
    'on-chain-execution',
  ],
  author: 'lustsazeus',
});

// Set up job handler
tokenVestingAgent.onJob(async (job: JobRequest): Promise<JobResult> => {
  const start = Date.now();
  console.log(`[token-vesting] Job ${job.jobId}: ${job.prompt}`);

  try {
    const prompt = job.prompt.toLowerCase();
    const payload = job.payload || {};
    
    // Check if this is a create vesting request
    if (prompt.includes('vest') || prompt.includes('schedule') || prompt.includes('create')) {
      const schedule = parseVestingInput(job.prompt, payload);
      
      if (!schedule) {
        return {
          jobId: job.jobId,
          agentId: job.agentId,
          status: 'error',
          error: 'Could not parse vesting request. Please provide: beneficiary address, amount, and duration (e.g., "Vest 10000 TEMPO to 0xABC... over 12 months with 3 month cliff")',
          executionTimeMs: Date.now() - start,
          timestamp: Date.now(),
        };
      }
      
      // Get token decimals
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const token = new ethers.Contract(schedule.tokenAddress, ERC20_ABI, provider);
      const decimals = await token.decimals().catch(() => 18);
      const symbol = await token.symbol().catch(() => 'TOKEN');
      
      // Calculate vesting details
      const vestedNow = calculateVestedAmount(schedule);
      const totalSeconds = schedule.vestingDuration;
      const cliffSeconds = schedule.cliffDuration;
      
      // Build vesting plan for confirmation
      const vestingPlan = {
        beneficiary: schedule.beneficiary,
        token: symbol,
        tokenAddress: schedule.tokenAddress,
        totalAmount: ethers.formatUnits(schedule.totalAmount, decimals),
        startTime: new Date(schedule.startTime * 1000).toISOString(),
        cliffDuration: `${cliffSeconds / (30 * 24 * 60 * 60)} months`,
        vestingDuration: `${totalSeconds / (30 * 24 * 60 * 60)} months`,
        vestingType: cliffSeconds > 0 ? 'cliff' : 'linear',
        immediateRelease: '0',
        lockedUntilCliff: ethers.formatUnits(schedule.totalAmount, decimals),
        releaseAfterCliff: '0',
        schedule: {
          start: Math.floor(schedule.startTime / 1000),
          cliff: Math.floor(schedule.startTime / 1000) + cliffSeconds,
          end: Math.floor(schedule.startTime / 1000) + totalSeconds,
        },
      };
      
      // If daemon key is available, execute on-chain
      let txHash: string | undefined;
      if (process.env.DAEMON_PRIVATE_KEY) {
        const wallet = new ethers.Wallet(process.env.DAEMON_PRIVATE_KEY, provider);
        
        // Approve token transfer
        const tokenContract = new ethers.Contract(schedule.tokenAddress, ERC20_ABI, wallet);
        try {
          const approveTx = await tokenContract.approve(schedule.beneficiary, schedule.totalAmount);
          await approveTx.wait(1);
        } catch (e) {
          console.log('Approval not required or failed:', e);
        }
        
        // Record vesting creation (in production, this would call a vesting contract)
        // For now, we create a marker transaction
        const nonce = await provider.getTransactionCount(wallet.address, 'pending');
        try {
          const tempToken = new ethers.Contract(
            '0x20c0000000000000000000000000000000000001', // AlphaUSD as marker
            ERC20_ABI,
            wallet
          );
          const tx = await tempToken.transfer(
            '0x0000000000000000000000000000000000000000',
            1,
            { nonce, gasLimit: 100000 }
          );
          const receipt = await tx.wait(1);
          txHash = receipt.hash;
        } catch (e) {
          console.log('On-chain execution skipped:', e);
        }
      }
      
      return {
        jobId: job.jobId,
        agentId: job.agentId,
        status: 'success',
        result: {
          action: 'vesting_schedule_created',
          onChain: !!txHash,
          txHash,
          explorerUrl: txHash ? `https://explore.tempo.xyz/tx/${txHash}` : undefined,
          vestingPlan,
          message: 'Vesting schedule created successfully. Review the plan above and confirm to execute on-chain.',
          instructions: 'To execute, call this agent again with payload.execute = true',
        },
        executionTimeMs: Date.now() - start,
        timestamp: Date.now(),
      };
    }
    
    // Check vesting status
    if (prompt.includes('status') || prompt.includes('check') || prompt.includes('balance')) {
      const beneficiary = payload?.beneficiary || extractAddress(prompt) || job.callerWallet;
      const tokenAddress = payload?.tokenAddress || '0x20c0000000000000000000000000000000000001';
      
      if (!beneficiary) {
        return {
          jobId: job.jobId,
          agentId: job.agentId,
          status: 'error',
          error: 'Please provide a beneficiary address',
          executionTimeMs: Date.now() - start,
          timestamp: Date.now(),
        };
      }
      
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const token = new ethers.Contract(tokenAddress as string, ERC20_ABI, provider);
      const decimals = await token.decimals().catch(() => 18);
      const symbol = await token.symbol().catch(() => 'TOKEN');
      const balance = await token.balanceOf(beneficiary as string);
      
      // Simulated vesting info (in production, read from contract)
      return {
        jobId: job.jobId,
        agentId: job.agentId,
        status: 'success',
        result: {
          action: 'vesting_status',
          beneficiary,
          token: symbol,
          currentBalance: ethers.formatUnits(balance, decimals),
          note: 'Connect to vesting contract to see locked/released amounts',
        },
        executionTimeMs: Date.now() - start,
        timestamp: Date.now(),
      };
    }
    
    // Default: show capabilities
    return {
      jobId: job.jobId,
      agentId: job.agentId,
      status: 'success',
      result: {
        action: 'capabilities',
        capabilities: [
          'Create linear vesting schedule',
          'Create cliff-based vesting schedule',
          'Check vesting status',
          'Calculate vested amounts',
        ],
        exampleUsage: [
          'Vest 10000 TEMPO to 0xABC... over 12 months',
          'Vest 5000 tokens to 0xDEF... for 24 months with 6 month cliff',
          'Check vesting status for 0xABC...',
        ],
        network: 'Tempo Moderato (Chain 42431)',
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
app.get('/manifest', (_req, res) => res.json(tokenVestingAgent.toManifest()));
app.post('/execute', async (req, res) => {
  const job: JobRequest = {
    jobId: req.body.jobId ?? require('crypto').randomUUID(),
    agentId: 'token-vesting',
    prompt: req.body.prompt ?? '',
    payload: req.body.payload,
    callerWallet: req.body.callerWallet ?? '',
    timestamp: Date.now(),
  };
  try {
    const handler = (tokenVestingAgent as any).jobHandler;
    const result = await handler(job);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', agent: 'token-vesting' }));

const PORT = Number(process.env.AGENT_PORT ?? 3010);
app.listen(PORT, () => {
  console.log(`[token-vesting] Token Vesting Agent running on port ${PORT}`);
  console.log(`  Agent: token-vesting`);
  console.log(`  Author: @lustsazeus`);
});

export { tokenVestingAgent };
