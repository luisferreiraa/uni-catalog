// src/app/api/uni-dialog/route.ts
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
})

// Tipos baseados na estrutura real da API
interface Translation {
    id: string
    language: string
    name: string
}

interface ControlField {
    id: string
    tag: string
    translations: Translation[]
}

interface SubFieldDef {
    id: string
    code: string
    name: string
}

interface DataField {
    id: string
    tag: string
    translations: Translation[]
    subFieldDef: SubFieldDef[]
}

interface Template {
    id: string
    name: string
    controlFields: ControlField[]
    dataFields: DataField[]
}

interface TemplatesResponse {
    templates: Template[]
}

async function fetchTemplates(): Promise<TemplatesResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
        const res = await fetch('http://89.28.236.11:3000/api/definitions/templates', {
            method: 'GET',
            headers: {
                'X-API-Key': 'c6039a26-dca4-4c1b-a915-1e6cc388e842',
                'Content-Type': 'application/json',
            },
            signal: controller.signal
        })

        clearTimeout(timeout)

        if (!res.ok) {
            const errorText = await res.text()
            console.error('Erro na API de templates:', res.status, errorText)
            return { templates: [] }
        }

        const data = await res.json()

        // Validação rigorosa da estrutura
        if (!data || !Array.isArray(data.templates)) {
            console.error('Formato inválido da API:', data)
            return { templates: [] }
        }

        // Filtra templates válidos
        const validTemplates = data.templates.filter((t: any) =>
            t?.id && t?.name && Array.isArray(t.controlFields) && Array.isArray(t.dataFields)
        )

        return { templates: validTemplates }
    } catch (error) {
        clearTimeout(timeout)
        console.error('Erro ao buscar templates:', error)
        return { templates: [] }
    }
}

type ConversationState = {
    step: 'initial' | 'clarifying' | 'complete'
    missingFields: string[]
    currentTemplate?: Template
    currentRecord?: Record<string, any>
}

function buildPrompt(description: string, templates: Template[], state: ConversationState, language: string): string {
    const safeTemplates = Array.isArray(templates) ? templates : []

    if (state.step === 'initial') {
        const templatesList = safeTemplates.map(t => {
            const controlFields = t.controlFields.map(f =>
                `${f.tag}: ${f.translations.find(t => t.language === language)?.name || f.translations[0]?.name}`
            ).join(', ')

            const dataFields = t.dataFields.map(f =>
                `${f.tag}: ${f.translations.find(t => t.language === language)?.name || f.translations[0]?.name}`
            ).join(', ')

            return `- ${t.name} (Campos: ${controlFields}; ${dataFields})`
        }).join('\n')

        return `
        Como especialista UNIMARC, analise:
        "${description}"
        
        Templates disponíveis:
        ${templatesList || 'Nenhum template disponível'}
        
        Instruções:
        1. Selecione o template mais adequado com base na descrição.
        2. Preencha os campos e subcampos que puder inferir diretamente a partir da descrição fornecida.
        3. Se faltar qualquer campo obrigatório e ele não for possível de inferir, você deve perguntar claramente ao utilizador o valor desses campos (type=question).
        4. Nunca devolva type=result se ainda houver campos obrigatórios por preencher.
        5. Nunca preencha campos com placeholders como "[DESCRIÇÃO FÍSICA]", "[número de páginas não especificado]", "[dimensões não especificadas]", ou equivalentes. Estes são considerados inválidos. Se o campo for obrigatório e não tiver dados suficientes, **pergunte claramente ao utilizador** com type="question".
        6. Responda no seguinte formato:
        {
            "type": "question" | "result",
            "question": "Texto da pergunta (se type=question)",
            "neededFields": ["campo1", "campo2"],
            "template": {
                "name": "Nome do template selecionado",
                "description": "Descrição gerada com base nos campos"
            },
            "fields": {
                "tag": {
                    "value": "valor principal",
                    "subfields": {
                        "code": "valor"
                    }
                }
            }
        }`
    } else {
        return `
        Continuando catalogação com:
        "${description}"
        
        Contexto atual:
        - Template: ${state.currentTemplate?.name || 'Nenhum'}
        - Campos preenchidos: ${JSON.stringify(state.currentRecord || {})}
        - Campos faltantes: ${state.missingFields.join(', ')}
        
        Instruções:
        1. Atualize os campos com base na nova informação fornecida.
        2. Tente inferir os valores com base no contexto da descrição ou nos campos já preenchidos.
        3. Se ainda restarem campos obrigatórios sem dados suficientes, formule perguntas específicas.
        4. Se o registro estiver completo, retorne todos os campos num único objeto JSON conforme o formato esperado.`
    }
}

export async function POST(req: NextRequest) {
    console.log('Iniciando processamento...')

    try {
        const { description, language = 'pt', conversationState } = await req.json()
        console.log('Dados recebidos:', { description, language })

        console.log('Buscando templates...')
        const { templates } = await fetchTemplates()
        console.log(`Recebidos ${templates.length} templates`)

        const state: ConversationState = conversationState || {
            step: 'initial',
            missingFields: []
        }

        const prompt = buildPrompt(description, templates, state, language)
        console.log('Prompt:', prompt)

        const completion = await openai.chat.completions.create({
            model: "gpt-4-1106-preview",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Você é um catalogador UNIMARC especializado. 
                    Use apenas os campos dos templates fornecidos. 
                    Idioma preferencial: ${language}.`
                },
                { role: "user", content: prompt + " JSON" }
            ],
            temperature: 0.2
        })

        const response = JSON.parse(completion.choices[0]?.message?.content || '{}')
        console.log('Resposta da OpenAI:', JSON.stringify(response, null, 2))

        // Atualiza estado com template selecionado
        if (response.template?.name) {
            state.currentTemplate = templates.find(t => t.name === response.template.name)
            state.currentRecord = response.fields || {}
        }

        if (response.type === 'question') {
            return NextResponse.json({
                type: 'question',
                question: response.question,
                neededFields: response.neededFields,
                conversationState: {
                    ...state,
                    step: 'clarifying',
                    missingFields: response.neededFields
                }
            })
        } else {
            return NextResponse.json({
                type: 'result',
                template: state.currentTemplate,
                fields: state.currentRecord,
                conversationState: {
                    ...state,
                    step: 'complete',
                    missingFields: []
                }
            })
        }

    } catch (error: any) {
        console.error('Erro no processamento:', error)
        return NextResponse.json({
            error: 'Processing error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }, { status: 500 })
    }
}