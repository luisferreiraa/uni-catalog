"use client"

import { useEffect, useState } from "react"

interface RecordSubField {
    code: string
    value: string
}

interface RecordField {
    tag: string
    value: string // Assumindo que é sempre string conforme o schema Prisma
    fieldType: string
    fieldName: string
    subfields?: { [key: string]: string | any } // JSON do Prisma, geralmente um objeto para subcampos
}

interface CatalogRecord {
    id: string
    createdAt: string
    fields: RecordField[]
    textUnimarc: string
}

export default function RecordsList() {
    const [records, setRecords] = useState<CatalogRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [visibleUnimarc, setVisibleUnimarc] = useState<{ [id: string]: boolean }>({})

    useEffect(() => {
        const fetchRecords = async () => {
            try {
                const res = await fetch("/api/records") // Chamada para a sua API Route
                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`)
                }
                const data = await res.json()
                setRecords(data.records)

                const visibilityState = Object.fromEntries(data.records.map((rec: CatalogRecord) => [rec.id, false]))
                setVisibleUnimarc(visibilityState)
            } catch (error) {
                console.error("Erro ao buscar registros:", error)
            } finally {
                setLoading(false)
            }
        }
        fetchRecords()
    }, [])

    const toggleUnimarc = (id: string) => {
        setVisibleUnimarc((prev) => ({ ...prev, [id]: !prev[id] }))
    }

    if (loading) return <div className="text-center">A carregar registos...</div>

    return (
        <div className="max-w-4xl mx-auto p-6 space-y-6">
            {records.map((record) => (
                <div key={record.id} className="border rounded-xl p-4 shadow">
                    <p className="text-sm text-gray-500 mb-2">Criado em: {new Date(record.createdAt).toLocaleString()}</p>
                    <ul className="space-y-1">
                        {record.fields.map((field, idx) => (
                            <li key={idx} className="text-sm">
                                <strong>{field.tag} - {field.fieldName}</strong> ({field.fieldType}):{" "}
                                {/* Renderiza subcampos se 'subfields' for um objeto e tiver chaves */}
                                {field.subfields && typeof field.subfields === "object" && Object.keys(field.subfields).length > 0 ? (
                                    <ul className="ml-4 mt-1 space-y-1 list-disc list-inside">
                                        {Object.entries(field.subfields).map(([subCode, subValue], sidx) => (
                                            <li key={sidx}>
                                                <em>${subCode}</em>: {String(subValue)}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    // Caso contrário, exibe o valor principal (que deve ser uma string)
                                    String(field.value) // Garante que o valor é tratado como string
                                )}
                            </li>
                        ))}
                    </ul>
                    {/* Botão para mostrar/esconder o UNIMARC */}
                    <button
                        onClick={() => toggleUnimarc(record.id)}
                        className="mt-4 px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
                    >
                        {visibleUnimarc[record.id] ? "Ocultar UNIMARC" : "Mostrar UNIMARC"}
                    </button>

                    {visibleUnimarc[record.id] && (
                        <div className="mt-2 p-2 bg-gray-50 rounded-md text-xs font-mono whitespace-pre-wrap">
                            {record.textUnimarc}
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}
