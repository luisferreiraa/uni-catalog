import { type NextRequest, NextResponse } from "next/server"
import { databaseService } from "@/lib/database"

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url)
        const page = Number.parseInt(searchParams.get("page") || "1")
        const limit = Number.parseInt(searchParams.get("limit") || "20")

        const result = await databaseService.listRecords(page, limit)

        return NextResponse.json(result)
    } catch (error) {
        console.error("Erro ao listar registros:", error)
        return NextResponse.json({ error: "Erro ao listar registros" }, { status: 500 })
    }
}