"use client"

import { prisma } from "@/lib/prisma"
import { useEffect, useState } from "react"

/**
 * Função que retorna uma lista paginada de registros da base de dados.
 * @param page Página atual (padrão = 1)
 * @param limit Quantidade de itens por página (padrão = 20)
 */
export async function listRecords(page = 1, limit = 20) {
    try {
        const skip = (page - 1) * limit

        // Usa Promise.all para buscar registros e contagem total ao mesmo tempo
        const [records, total] = await Promise.all([
            prisma.catalogRecord.findMany({
                skip,
                take: limit,
                orderBy: { createdAt: "desc" },
                include: {
                    fields: {
                        select: {
                            tag: true,
                            value: true,
                            fieldType: true,
                        },
                    },
                },
            }),
            prisma.catalogRecord.count(),
        ])

        // Retorna objeto com paginação
        return {
            records,
            total,
            pages: Math.ceil(total / limit),
            currentPage: page,
        }
    } catch (error) {
        console.error("Erro ao listar registros:", error)
        throw new Error("Falha ao listar registros")
    }
}

interface RecordField {
    tag: string
    value: string
    fieldType: string
}

interface CatalogRecord {
    id: string
    createdAt: string
    fields: RecordField[]
}

export default function RecordsList() {
    const [records, setRecords] = useState<CatalogRecord[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        // Chamada à API para buscar registros
        const fetchRecords = async () => {
            try {
                const res = await fetch("/api/records") // endpoint a criar
                const data = await res.json()
                setRecords(data.records)
            } catch (error) {
                console.error("Erro ao buscar registros:", error)
            } finally {
                setLoading(false)
            }
        }

        fetchRecords()
    }, [])

    if (loading) return <div className="text-center">A carregar registos...</div>

    return (
        <div className="max-w-4xl mx-auto p-6 space-y-6">
            {records.map((record) => (
                <div key={record.id} className="border rounded-xl p-4 shadow">
                    <p className="text-sm text-gray-500 mb-2">Criado em: {new Date(record.createdAt).toLocaleString()}</p>
                    <ul className="space-y-1">
                        {record.fields.map((field, idx) => (
                            <li key={idx} className="text-sm">
                                <strong>{field.tag}</strong> ({field.fieldType}): {field.value}
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    )
}




