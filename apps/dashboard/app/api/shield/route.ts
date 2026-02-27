// ═══════════════════════════════════════════════════════════
// PayPol Shield API — Real ZK-SNARK (Circom V2 + snarkjs)
// Poseidon commitment generation + PLONK proof generation
// ═══════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import * as crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

/**
 * Generate a cryptographically secure random field element for BN254 ZK circuits.
 * 31 bytes = 248 bits, safely within the BN254 scalar field order.
 */
function generateRandomSecret(): string {
    const bytes = crypto.randomBytes(31);
    return BigInt("0x" + bytes.toString("hex")).toString();
}

/**
 * Resolve circuit artifact paths — works in both dev and Docker.
 * Dev: apps/dashboard → ../../packages/circuits/
 * Docker: /app → /app/circuits/ (copied at build time)
 */
function getCircuitPaths() {
    // Try Docker path first (production)
    const dockerWasm = path.join(process.cwd(), 'circuits', 'paypol_shield_v2.wasm');
    const dockerZkey = path.join(process.cwd(), 'circuits', 'paypol_shield_v2_final.zkey');
    if (fs.existsSync(dockerWasm) && fs.existsSync(dockerZkey)) {
        return { wasmPath: dockerWasm, zkeyPath: dockerZkey };
    }

    // Dev path (monorepo)
    const devWasm = path.join(process.cwd(), '..', '..', 'packages', 'circuits', 'paypol_shield_v2_js', 'paypol_shield_v2.wasm');
    const devZkey = path.join(process.cwd(), '..', '..', 'packages', 'circuits', 'paypol_shield_v2_final.zkey');
    if (fs.existsSync(devWasm) && fs.existsSync(devZkey)) {
        return { wasmPath: devWasm, zkeyPath: devZkey };
    }

    throw new Error(`ZK V2 circuit files not found. Searched: ${dockerWasm} and ${devWasm}`);
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { action } = body;

        // ═══════════════════════════════════════════════════
        // ACTION: generate_commitment
        // Generates Poseidon commitment for ShieldVaultV2.deposit()
        // Returns: { commitment, nullifierHash, secret, nullifier }
        // ═══════════════════════════════════════════════════
        if (action === 'generate_commitment') {
            const { amount, recipient, tokenDecimals = 6 } = body;

            if (!amount || !recipient) {
                return NextResponse.json({ error: "Missing amount or recipient" }, { status: 400 });
            }

            // Normalize recipient to BigInt string (strip 0x prefix)
            let cleanRecipient = recipient.toLowerCase().trim();
            if (!/^0x[a-fA-F0-9]{40}$/.test(cleanRecipient)) {
                return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
            }
            const recipientBigInt = BigInt(cleanRecipient).toString();

            // Scale amount to token units (e.g., 6 decimals → multiply by 1e6)
            const scaledAmount = Math.floor(Number(amount) * Math.pow(10, tokenDecimals)).toString();

            // Generate cryptographic secrets
            const secret = generateRandomSecret();
            const nullifier = generateRandomSecret();

            // Compute Poseidon hashes matching Circom V2 circuit:
            // commitment = Poseidon(secret, nullifier, amount, recipient)
            // nullifierHash = Poseidon(nullifier, secret)
            const circomlibjs = require("circomlibjs");
            const poseidon = await circomlibjs.buildPoseidon();

            const commitHash = poseidon([
                BigInt(secret),
                BigInt(nullifier),
                BigInt(scaledAmount),
                BigInt(recipientBigInt)
            ]);
            const commitment = poseidon.F.toObject(commitHash).toString();

            const nullHash = poseidon([BigInt(nullifier), BigInt(secret)]);
            const nullifierHash = poseidon.F.toObject(nullHash).toString();

            console.log(`🔐 [Shield] Commitment generated for ${amount} tokens → ${commitment.slice(0, 20)}...`);

            return NextResponse.json({
                success: true,
                commitment,
                nullifierHash,
                secret,
                nullifier,
                scaledAmount,
                recipientBigInt,
            });
        }

        // ═══════════════════════════════════════════════════
        // ACTION: generate_proof
        // Generates full ZK-SNARK proof for on-chain verification
        // Used by daemon to call ShieldVaultV2.executeShieldedPayout()
        // Returns: { proofArray, pubSignals }
        // ═══════════════════════════════════════════════════
        if (action === 'generate_proof') {
            const { secret, nullifier, amount, recipient } = body;

            if (!secret || !nullifier || !amount || !recipient) {
                return NextResponse.json({ error: "Missing proof inputs (secret, nullifier, amount, recipient)" }, { status: 400 });
            }

            const recipientBigInt = BigInt(recipient.toLowerCase().trim()).toString();

            const circomlibjs = require("circomlibjs");
            const poseidon = await circomlibjs.buildPoseidon();

            // Recompute commitment and nullifierHash
            const commitHash = poseidon([BigInt(secret), BigInt(nullifier), BigInt(amount), BigInt(recipientBigInt)]);
            const commitment = poseidon.F.toObject(commitHash).toString();

            const nullHash = poseidon([BigInt(nullifier), BigInt(secret)]);
            const nullifierHash = poseidon.F.toObject(nullHash).toString();

            const circuitInputs = {
                commitment,
                nullifierHash,
                recipient: recipientBigInt,
                amount: amount.toString(),
                secret: secret.toString(),
                nullifier: nullifier.toString(),
            };

            // Load circuit artifacts
            const { wasmPath, zkeyPath } = getCircuitPaths();

            // @ts-ignore — snarkjs has no TypeScript definitions
            const snarkjs = require("snarkjs");
            const { proof, publicSignals } = await snarkjs.plonk.fullProve(circuitInputs, wasmPath, zkeyPath);

            // Export Solidity calldata: uint256[24] proof + uint256[3] pubSignals
            const calldata = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
            const calldataStr = String(calldata);

            const splitIndex = calldataStr.indexOf('][');
            if (splitIndex === -1) throw new Error("Invalid PLONK calldata format from snarkjs.");

            const proofArray: string[] = JSON.parse(calldataStr.substring(0, splitIndex + 1));
            const pubSignalsArray: string[] = JSON.parse(calldataStr.substring(splitIndex + 1));

            console.log(`🛡️ [Shield] ZK-SNARK proof generated. Commitment: ${commitment.slice(0, 20)}...`);

            return NextResponse.json({
                success: true,
                proofArray,
                pubSignals: pubSignalsArray,
                commitment,
                nullifierHash,
            });
        }

        return NextResponse.json({ error: "Unknown action. Use 'generate_commitment' or 'generate_proof'." }, { status: 400 });

    } catch (error: any) {
        console.error("❌ [Shield API] Error:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
