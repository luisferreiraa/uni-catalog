import { type NextRequest, NextResponse } from "next/server"
import { databaseService } from "@/lib/database"

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const record = await databaseService.getRecord(params.id)

        if (!record) {
            return NextResponse.json({ error: "Registro não encontrado" }, { status: 404 })
        }

        return NextResponse.json(record)
    } catch (error) {
        console.error("Erro ao buscar registro:", error)
        return NextResponse.json({ error: "Erro ao buscar registro" }, { status: 500 })
    }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        await databaseService.deleteRecord(params.id)
        return NextResponse.json({ success: true })
    } catch (error) {
        console.error("Erro ao remover registro:", error)
        return NextResponse.json({ error: "Erro ao remover registro" }, { status: 500 })
    }
}