/**
 * Token Vesting Agent Tests
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

// Mock vesting calculation tests
describe('Vesting Calculations', () => {
  interface VestingSchedule {
    beneficiary: string;
    tokenAddress: string;
    totalAmount: bigint;
    startTime: number;
    cliffDuration: number;
    vestingDuration: number;
  }

  function calculateVestedAmount(schedule: VestingSchedule, currentTime: number = Date.now() / 1000): bigint {
    const { totalAmount, startTime, cliffDuration, vestingDuration } = schedule;
    
    // Use integer math - floor all times
    const currentTimeInt = Math.floor(currentTime);
    const startTimeInt = Math.floor(startTime);
    const cliffDurationInt = Math.floor(cliffDuration);
    const vestingDurationInt = Math.floor(vestingDuration);
    
    if (currentTimeInt < startTimeInt) {
      return 0n;
    }
    
    const timePassed = currentTimeInt - startTimeInt;
    
    if (timePassed < cliffDurationInt) {
      return 0n;
    }
    
    if (timePassed >= vestingDurationInt) {
      return totalAmount;
    }
    
    const vestedRatio = BigInt(timePassed - cliffDurationInt) * BigInt(1e18) / BigInt(vestingDurationInt - cliffDurationInt);
    return totalAmount * vestedRatio / BigInt(1e18);
  }

  it('should return 0 before start time', () => {
    const schedule: VestingSchedule = {
      beneficiary: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      totalAmount: ethers.parseEther('10000'),
      startTime: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days from now
      cliffDuration: 0,
      vestingDuration: 86400 * 365, // 1 year
    };

    const vested = calculateVestedAmount(schedule);
    expect(vested).toBe(0n);
  });

  it('should return 0 before cliff', () => {
    const schedule: VestingSchedule = {
      beneficiary: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      totalAmount: ethers.parseEther('10000'),
      startTime: Math.floor(Date.now() / 1000) - 86400 * 10, // Started 10 days ago
      cliffDuration: 86400 * 30, // 30 day cliff
      vestingDuration: 86400 * 365, // 1 year vesting
    };

    const vested = calculateVestedAmount(schedule);
    expect(vested).toBe(0n);
  });

  it('should vest linearly after cliff', () => {
    const totalAmount = 10000n * 10n ** 18n;
    const schedule: VestingSchedule = {
      beneficiary: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      totalAmount,
      startTime: Math.floor(Date.now() / 1000) - 86400 * 60, // 60 days ago
      cliffDuration: 86400 * 30, // 30 day cliff
      vestingDuration: 86400 * 120, // 120 day vesting (90 days after cliff)
    };

    const vested = calculateVestedAmount(schedule);
    // At day 60: 30 days after cliff (start + 60 - 30 = 30 days into vesting)
    // 30 / 90 = 33.33% vested
    expect(vested).toBeGreaterThan(0n);
    expect(vested).toBeLessThan(totalAmount);
  });

  it('should return full amount after vesting period', () => {
    const totalAmount = 10000n * 10n ** 18n;
    const schedule: VestingSchedule = {
      beneficiary: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      totalAmount,
      startTime: Math.floor(Date.now() / 1000) - 86400 * 400, // 400 days ago
      cliffDuration: 86400 * 30, // 30 day cliff
      vestingDuration: 86400 * 365, // 1 year vesting
    };

    const vested = calculateVestedAmount(schedule);
    expect(vested).toBe(totalAmount);
  });

  it('should handle zero cliff (linear vesting)', () => {
    const totalAmount = 10000n * 10n ** 18n;
    const schedule: VestingSchedule = {
      beneficiary: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      totalAmount,
      startTime: Math.floor(Date.now() / 1000) - 86400 * 182, // 182 days ago (50% of year)
      cliffDuration: 0,
      vestingDuration: 86400 * 365, // 1 year vesting
    };

    const vested = calculateVestedAmount(schedule);
    // Should be approximately 50% vested
    const halfAmount = totalAmount / 2n;
    const tolerance = totalAmount / 100n; // 1% tolerance
    
    expect(vested).toBeGreaterThan(halfAmount - tolerance);
    expect(vested).toBeLessThan(halfAmount + tolerance);
  });
});
