'use client'
import { useState } from 'react'

type ConversationState = {
    step: 'initial' | 'clarifying' | 'complete'
    missingFields: string[]
}

export default function InteractiveUnimarcCataloguer() {
    const [input, setInput] = useState('')
    const [language, setLanguage] = useState('pt')
    const [conversation, setConversation] = useState<{
        state: ConversationState
        messages: Array<{
            type: 'user' | 'system' | 'question'
            content: string
            fields?: string[]
        }>
    }>({
        state: { step: 'initial', missingFields: [] },
        messages: []
    })
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (userResponse?: string) => {
        setLoading(true)

        try {
            const response = await fetch('/api/uni-dialog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: userResponse || input,
                    language,
                    conversationState: conversation.state
                })
            })

            const data = await response.json()

            if (!response.ok) throw new Error(data.error || 'Erro desconhecido')

            if (data.type === 'question') {
                setConversation(prev => ({
                    state: data.conversationState as ConversationState,
                    messages: [
                        ...prev.messages,
                        ...(userResponse ? [{
                            type: 'user' as const,
                            content: userResponse
                        }] : []),
                        {
                            type: 'question' as const,
                            content: data.question as string,
                            fields: data.neededFields as string[]
                        }
                    ]
                }))
            } else {
                setConversation(prev => ({
                    state: data.conversationState,
                    messages: [
                        ...prev.messages,
                        ...(userResponse ? [{
                            type: 'user' as const,
                            content: userResponse
                        }] : []),
                        {
                            type: 'system' as const,
                            content: 'Catalogação completa!'
                        }
                    ]
                }))
                // Processar resultado final como antes
            }
        } catch (err: any) {
            setConversation(prev => ({
                ...prev,
                messages: [
                    ...prev.messages,
                    {
                        type: 'system',
                        content: `Erro: ${err.message}`
                    }
                ]
            }))
        } finally {
            setLoading(false)
        }
    }

    const handleAnswer = (answer: string) => {
        handleSubmit(answer)
    }

    return (
        <div className="container mx-auto p-4 max-w-4xl bg-white rounded-lg shadow text-black">
            <h1 className="text-2xl font-bold mb-6">Catalogação UNIMARC Interativa</h1>

            {/* Área de diálogo */}
            <div className="mb-6 h-96 overflow-y-auto border rounded-lg p-4 bg-gray-50">
                {conversation.messages.length === 0 && (
                    <p className="text-gray-500">Descreva o item bibliográfico para começar...</p>
                )}

                {conversation.messages.map((msg, i) => (
                    <div key={i} className={`mb-3 p-3 rounded-lg ${msg.type === 'user' ? 'bg-blue-100 ml-auto max-w-3/4' : 'bg-gray-100 mr-auto max-w-3/4'}`}>
                        <p>{msg.content}</p>

                        {msg.type === 'question' && msg.fields && (
                            <div className="mt-2">
                                <p className="text-sm font-semibold">Informações necessárias:</p>
                                <ul className="list-disc pl-5 text-sm">
                                    {msg.fields.map(field => (
                                        <li key={field}>{field}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                ))}

                {loading && (
                    <div className="text-center py-4">
                        <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
                    </div>
                )}
            </div>

            {/* Entrada do usuário */}
            <div className="flex gap-2">
                <input
                    type="text"
                    className="flex-1 border rounded p-2 text-black"
                    placeholder={conversation.state.step === 'initial'
                        ? "Descreva o item bibliográfico..."
                        : "Forneça as informações solicitadas..."}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !loading) {
                            handleAnswer(e.currentTarget.value)
                            e.currentTarget.value = ''
                        }
                    }}
                    disabled={loading}
                />
                <button
                    onClick={() => {
                        const input = document.querySelector('input')
                        if (input?.value) {
                            handleAnswer(input.value)
                            input.value = ''
                        }
                    }}
                    disabled={loading}
                    className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
                >
                    Enviar
                </button>
            </div>

            {/* Exibição do resultado final (quando completo) */}
            {conversation.state.step === 'complete' && (
                <div className="mt-6">
                    {/* Componente de visualização de resultado como antes */}
                </div>
            )}
        </div>
    )
}