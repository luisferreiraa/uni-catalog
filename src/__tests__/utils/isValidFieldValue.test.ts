import { isValidFieldValue } from "@/app/api/uni-dialog/route"

describe("isValidFieldValue", () => {
    // Mock de um fieldDef para testes de obrigatoriedade
    const mandatoryField = { mandatory: true }
    const optionalField = { mandatory: false }

    it("should return false or undefined, null, or empty string", () => {
        expect(isValidFieldValue(undefined)).toBe(false)
        expect(isValidFieldValue(null)).toBe(false)
        expect(isValidFieldValue("")).toBe(false)
        expect(isValidFieldValue("   ")).toBe(false)
    })

    it("should return true for valid non-empty strings", () => {
        expect(isValidFieldValue("some value")).toBe(true)
        expect(isValidFieldValue("0")).toBe(true)
        expect(isValidFieldValue("false")).toBe(true)
    })

    it('should handle "não" and similar values correctly for optional fields', () => {
        expect(isValidFieldValue("não", optionalField)).toBe(false)
        expect(isValidFieldValue("nao", optionalField)).toBe(false)
        expect(isValidFieldValue("n/a", optionalField)).toBe(false)
        expect(isValidFieldValue("-", optionalField)).toBe(false)
        expect(isValidFieldValue("none", optionalField)).toBe(false)
        expect(isValidFieldValue("null", optionalField)).toBe(false)
    })

    it('shouuld handle "não" and similar values correctly for mandatory fields', () => {
        // For mandatory fields, "não" is considered invalid, so it returns true only if it's a valid value
        // The function itself returns false for "não", so it will be treated as invalid
        // The API route logic then decides if it should be asked again or stored as null
        expect(isValidFieldValue("não", mandatoryField)).toBe(false)
        expect(isValidFieldValue("nao", mandatoryField)).toBe(false)
    })

    it("should return true if any item in an array is valid", () => {
        expect(isValidFieldValue(["", "valid", null])).toBe(true)
        expect(isValidFieldValue([null, undefined, "   "])).toBe(false)
        expect(isValidFieldValue(["valid1", "valid2"])).toBe(true)
    })

    it("should return true if any value in an object is valid", () => {
        expect(isValidFieldValue({ a: "", b: "valid" })).toBe(true)
        expect(isValidFieldValue({ a: null, b: undefined })).toBe(false)
        expect(isValidFieldValue({ a: "valid1", b: "valid2" })).toBe(true)
    })

    it("should handle nested structures", () => {
        expect(isValidFieldValue({ a: "", b: ["valid"] })).toBe(true)
        expect(isValidFieldValue({ a: null, b: [""] })).toBe(false)
        expect(isValidFieldValue(["", { a: "valid" }])).toBe(true)
    })


})