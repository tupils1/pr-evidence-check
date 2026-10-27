import { describe, expect, it } from 'vitest'

describe('contradicted claim demo', () => {
  it('fails on purpose so a passing-test claim is contradicted', () => {
    expect(1).toBe(2)
  })
})
