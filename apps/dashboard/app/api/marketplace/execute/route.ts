import { NextResponse } from 'next/server';
import prisma from '@/app/lib/prisma';
import { ethers } from 'ethers';

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://localhost:3001';
const RPC_URL = "https://rpc.moderato.tempo.xyz";
const AI_PROOF_REGISTRY_ADDRESS = "0x8fDB8E871c9eaF2955009566F41490Bbb128a014";

const AI_PROOF_REGISTRY_ABI = [
    "function commit(bytes32 planHash, uint256 nexusJobId) external returns (bytes32)",
    "function verify(bytes32 commitmentId, bytes32 resultHash) external",
    "event CommitmentMade(bytes32 indexed commitmentId, address indexed agent, uint256 indexed nexusJobId, bytes32 planHash)",
    "event CommitmentVerified(bytes32 indexed commitmentId, bool matched, bytes32 resultHash)",
];

/**
 * Get daemon wallet for signing AIProofRegistry transactions.
 * Returns null if DAEMON_PRIVATE_KEY is not configured.
 */
function getDaemonWallet(): ethers.Wallet | null {
    const pk = process.env.DAEMON_PRIVATE_KEY;
    if (!pk) return null;
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(pk, provider);
}

export async function POST(req: Request) {
    try {
        const { jobId } = await req.json();

        if (!jobId) {
            return NextResponse.json({ error: "Missing jobId." }, { status: 400 });
        }

        // 1. Fetch job + agent
        const job = await prisma.agentJob.findUnique({
            where: { id: jobId },
            include: { agent: true },
        });

        if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
        if (job.status !== 'ESCROW_LOCKED' && job.status !== 'MATCHED') {
            return NextResponse.json({ error: `Cannot execute job in status: ${job.status}` }, { status: 400 });
        }

        // 2. Mark as executing
        await prisma.agentJob.update({
            where: { id: jobId },
            data: { status: 'EXECUTING' },
        });

        // ═══════════════════════════════════════════════════════
        // AI PROOF REGISTRY — Pre-Execution Commitment
        // Hash the agent's plan (prompt + task) and commit on-chain
        // ═══════════════════════════════════════════════════════
        let commitmentId: string | null = null;
        let planHash: string | null = null;
        let commitTxHash: string | null = null;

        try {
            const daemonWallet = getDaemonWallet();
            if (daemonWallet && job.onChainJobId) {
                const registry = new ethers.Contract(AI_PROOF_REGISTRY_ADDRESS, AI_PROOF_REGISTRY_ABI, daemonWallet);

                // planHash = keccak256(prompt + taskDescription)
                const planString = (job.prompt || '') + (job.taskDescription || '');
                planHash = ethers.keccak256(ethers.toUtf8Bytes(planString));

                console.log(`🔐 [AIProof] Committing planHash for Job #${job.onChainJobId}: ${planHash.slice(0, 20)}...`);

                const commitTx = await registry.commit(
                    planHash,
                    job.onChainJobId,
                    { gasLimit: 300000, type: 0 }
                );
                const receipt = await commitTx.wait(1);
                commitTxHash = commitTx.hash;
                const iface = new ethers.Interface(AI_PROOF_REGISTRY_ABI);
                for (const log of receipt.logs) {
                    try {
                        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
                        if (parsed && parsed.name === 'CommitmentMade') {
                            commitmentId = parsed.args[0]; // commitmentId (bytes32)
                            break;
                        }
                    } catch { /* skip non-matching logs */ }
                }

                // Store commitment data immediately
                await prisma.agentJob.update({
                    where: { id: jobId },
                    data: { planHash, commitmentId, commitTxHash },
                });

                console.log(`✅ [AIProof] Commitment recorded. ID: ${commitmentId?.slice(0, 20)}... TX: ${commitTxHash}`);
            }
        } catch (proofError: any) {
            console.error(`⚠️ [AIProof] Commitment failed (non-blocking):`, proofError.reason || proofError.message);
            // Non-blocking: agent execution continues even if proof commitment fails
        }

        const startTime = Date.now();
        let result: any = null;
        let finalStatus = 'COMPLETED';

        try {
            if (job.agent.nativeAgentId) {
                // ════════════════════════════════════════
                // NATIVE PAYPOL AGENT (Claude-powered)
                // ════════════════════════════════════════
                const response = await fetch(`${AGENT_SERVICE_URL}/agents/${job.agent.nativeAgentId}/execute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: job.prompt,
                        taskDescription: job.taskDescription,
                        budget: job.budget,
                        callerWallet: job.clientWallet,
                    }),
                    signal: AbortSignal.timeout(120000), // 2 min timeout
                });

                if (!response.ok) {
                    throw new Error(`Agent service returned ${response.status}`);
                }

                result = await response.json();

            } else if (job.agent.webhookUrl) {
                // ════════════════════════════════════════
                // THIRD-PARTY AGENT (via webhook)
                // ════════════════════════════════════════
                const response = await fetch(job.agent.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId: job.id,
                        prompt: job.prompt,
                        taskDescription: job.taskDescription,
                        budget: job.budget,
                        callerWallet: job.clientWallet,
                        token: job.token,
                    }),
                    signal: AbortSignal.timeout(120000),
                });

                if (!response.ok) {
                    throw new Error(`Webhook returned ${response.status}`);
                }

                result = await response.json();

            } else {
                // ════════════════════════════════════════
                // NO EXECUTION ENDPOINT - Simulate for demo agents
                // ════════════════════════════════════════
                result = {
                    status: 'completed',
                    output: `Task "${job.prompt}" has been queued for processing by ${job.agent.name}. The agent will deliver results to your workspace.`,
                    metadata: {
                        agentName: job.agent.name,
                        category: job.agent.category,
                        estimatedTime: `${job.agent.responseTime}s`,
                    },
                };
            }
        } catch (execError: any) {
            console.error(`[Execute] Agent execution failed:`, execError.message);
            finalStatus = 'FAILED';
            result = { error: execError.message };
        }

        const executionTime = Math.round((Date.now() - startTime) / 1000);

        // ═══════════════════════════════════════════════════════
        // AI PROOF REGISTRY — Post-Execution Verification
        // Hash the result and verify on-chain against the commitment
        // ═══════════════════════════════════════════════════════
        let resultHash: string | null = null;
        let verifyTxHash: string | null = null;
        let proofMatched: boolean | null = null;

        try {
            const daemonWallet = getDaemonWallet();
            if (daemonWallet && commitmentId && finalStatus === 'COMPLETED') {
                const registry = new ethers.Contract(AI_PROOF_REGISTRY_ADDRESS, AI_PROOF_REGISTRY_ABI, daemonWallet);

                // resultHash = keccak256(JSON.stringify(result))
                resultHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(result)));

                console.log(`🔐 [AIProof] Verifying result for commitment ${commitmentId.slice(0, 20)}...`);

                const verifyTx = await registry.verify(
                    commitmentId,
                    resultHash,
                    { gasLimit: 300000, type: 0 }
                );
                const verifyReceipt = await verifyTx.wait(1);
                verifyTxHash = verifyTx.hash;

                // Parse proofMatched from CommitmentVerified event
                const iface = new ethers.Interface(AI_PROOF_REGISTRY_ABI);
                for (const log of verifyReceipt.logs) {
                    try {
                        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
                        if (parsed && parsed.name === 'CommitmentVerified') {
                            proofMatched = parsed.args[1]; // matched (bool)
                            break;
                        }
                    } catch { /* skip non-matching logs */ }
                }

                console.log(`✅ [AIProof] Verification complete. Matched: ${proofMatched}. TX: ${verifyTxHash}`);
            }
        } catch (verifyError: any) {
            console.error(`⚠️ [AIProof] Verification failed (non-blocking):`, verifyError.reason || verifyError.message);
        }

        // 3. Update job with result + AI proof data
        await prisma.agentJob.update({
            where: { id: jobId },
            data: {
                status: finalStatus,
                result: JSON.stringify(result),
                executionTime,
                completedAt: new Date(),
                ...(resultHash && { resultHash }),
                ...(verifyTxHash && { verifyTxHash }),
                ...(proofMatched !== null && { proofMatched }),
            },
        });

        // 4. Update agent stats
        const agent = job.agent;
        const newTotal = agent.totalJobs + 1;
        const prevSuccessCount = Math.round(agent.successRate * agent.totalJobs / 100);
        const newSuccessCount = finalStatus === 'COMPLETED' ? prevSuccessCount + 1 : prevSuccessCount;
        const newRate = newTotal > 0 ? (newSuccessCount / newTotal) * 100 : 100;

        await prisma.marketplaceAgent.update({
            where: { id: agent.id },
            data: {
                totalJobs: newTotal,
                successRate: Math.round(newRate * 10) / 10,
                responseTime: Math.round((agent.responseTime * agent.totalJobs + executionTime) / newTotal),
            },
        });

        return NextResponse.json({
            success: finalStatus === 'COMPLETED',
            status: finalStatus,
            result,
            executionTime,
        });

    } catch (error: any) {
        console.error("[Marketplace Execute]", error);
        return NextResponse.json({ error: "Execution failed." }, { status: 500 });
    }
}
