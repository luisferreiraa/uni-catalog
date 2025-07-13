// src/app/api/uni-dialog/route.ts
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

// Configuração inicial do cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY      // A chave API é carregada das variáveis de ambiente
})

/**
 * Interfaces que definem a estrutura dos dados da API de templates
 * Estas interfaces refletem a estrutura esperada da API externa de definições UNIMARC
 */

// Representa uma tradução de um campo
interface Translation {
    id: string
    language: string
    name: string
}

// Representa um campo de controlo no template UNIMARC
interface ControlField {
    id: string
    tag: string
    translations: Translation[]
}

// Representa a definição de um subcampo
interface SubFieldDef {
    id: string
    code: string
    name: string
}

// Representa um campo de dados no template UNIMARC
interface DataField {
    id: string
    tag: string
    translations: Translation[]
    subFieldDef: SubFieldDef[]
}

// Representa um template completo de catalogação
interface Template {
    id: string
    name: string
    controlFields: ControlField[]
    dataFields: DataField[]
}

// Estrutura de resposta da API de templates
interface TemplatesResponse {
    templates: Template[]
}

/**
 * Função para buscar templates da API externa
 * Implementa timeout e tratamento de erros robusto
 */
async function fetchTemplates(): Promise<TemplatesResponse> {
    // Configura timeout de 8 segundos utilizando AbortController
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
        // Faz a requisição para a API de templates
        const res = await fetch('http://89.28.236.11:3000/api/definitions/templates', {
            method: 'GET',
            headers: {
                'X-API-Key': 'c6039a26-dca4-4c1b-a915-1e6cc388e842',        // Chave API fixa
                'Content-Type': 'application/json',
            },
            signal: controller.signal       // Vincula o abort signal
        })

        clearTimeout(timeout)       // Limpa o timeout se a requisição completar

        // Trata erros HTTP
        if (!res.ok) {
            const errorText = await res.text()
            console.error('Erro na API de templates:', res.status, errorText)
            return { templates: [] }        // Retorna array vazio em caso de erro
        }

        const data = await res.json()

        // Validação da estrutura de resposta
        if (!data || !Array.isArray(data.templates)) {
            console.error('Formato inválido da API:', data)
            return { templates: [] }
        }

        // Filtra apenas templates com estrutura válida
        const validTemplates = data.templates.filter((t: any) =>
            t?.id && t?.name && Array.isArray(t.controlFields) && Array.isArray(t.dataFields)
        )

        return { templates: validTemplates }
    } catch (error) {
        clearTimeout(timeout)
        console.error('Erro ao buscar templates:', error)
        return { templates: [] }        // Retorna array vazio em caso de erro
    }
}

/**
 * Tipo que define o estado da conversa com o utilizador
 * Mantém o contexto entre múltiplas interações
 */
type ConversationState = {
    step: 'initial' | 'clarifying' | 'complete'     // Fase do diálogo
    missingFields: string[]     // Campos obrigatórios em falta
    currentTemplate?: Template      // Template selecionado
    currentRecord?: Record<string, any>     // Campos já preenchidos
}

/**
 * Constrói o prompt para a OpenAI com base no estado atual
 * @param description Descrição do item a ser catalogado
 * @param templates Lista de templates disponíveis
 * @param state Estado atual da conversa
 * @param language Idioma preferido para resposta
 * @returns 
 */
function buildPrompt(description: string, templates: Template[], state: ConversationState, language: string): string {
    const safeTemplates = Array.isArray(templates) ? templates : []

    if (state.step === 'initial') {
        // Constrói uma lista formatada dos templates para o prompt
        const templatesList = safeTemplates.map(t => {
            // Formata campos de controle
            const controlFields = t.controlFields.map(f =>
                `${f.tag}: ${f.translations.find(t => t.language === language)?.name || f.translations[0]?.name}`
            ).join(', ')

            // Formata campos de dados
            const dataFields = t.dataFields.map(f =>
                `${f.tag}: ${f.translations.find(t => t.language === language)?.name || f.translations[0]?.name}`
            ).join(', ')

            return `- ${t.name} (Campos: ${controlFields}; ${dataFields})`
        }).join('\n')

        // Prompt inicial com instruções detalhadas
        return `
        Como especialista UNIMARC, analise:
        "${description}"
        
        Templates disponíveis:
        ${templatesList || 'Nenhum template disponível'}
        
        Instruções:
        1. Selecione o template mais adequado com base na descrição.
        2. Preencha os campos e subcampos que puder inferir diretamente a partir da descrição fornecida.
        3. Se faltar qualquer campo obrigatório ou não e ele não for possível de inferir, você deve perguntar claramente ao utilizador o valor desses campos (type=question).
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
        // Prompt para continuação da conversa
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

/**
 * Handler principal da API
 * Processa requisições POST para o diálogo de catalogação
 */
export async function POST(req: NextRequest) {
    console.log('Iniciando processamento...')

    try {
        // Extrai os dados da requisição
        const { description, language = 'pt', conversationState } = await req.json()
        console.log('Dados recebidos:', { description, language })

        // Busca templates da API externa
        console.log('Buscando templates...')
        const { templates } = await fetchTemplates()
        console.log(`Recebidos ${templates.length} templates`)

        // Inicializa ou usa o estado da conversa existente
        const state: ConversationState = conversationState || {
            step: 'initial',
            missingFields: []
        }

        // Contrói o prompt para a OpenAI
        const prompt = buildPrompt(description, templates, state, language)
        console.log('Prompt:', prompt)

        // Chama a API da OpenAI
        const completion = await openai.chat.completions.create({
            model: "gpt-4-1106-preview",        // Usa o modelo mais recente do GPT-4
            response_format: { type: "json_object" },       // Força resposta em JSON
            messages: [
                {
                    role: "system",
                    content: `Você é um catalogador UNIMARC especializado. 
                    Use apenas os campos dos templates fornecidos. 
                    Idioma preferencial: ${language}.`
                },
                { role: "user", content: prompt + " JSON" }     // Adiciona JSON para reforçar o formato
            ],
            temperature: 0.2        // Baiax temperatura para respostas mais determinísticas
        })

        // Processa a resposta da OpenAI
        const response = JSON.parse(completion.choices[0]?.message?.content || '{}')
        console.log('Resposta da OpenAI:', JSON.stringify(response, null, 2))

        // Atualiza estado com template selecionado (se aplicável)
        if (response.template?.name) {
            state.currentTemplate = templates.find(t => t.name === response.template.name)
            state.currentRecord = response.fields || {}
        }

        // Prepara a resposta com base no tipo (pergunta ou resultado)
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
        // Tratamento de erros detalhado
        console.error('Erro no processamento:', error)
        return NextResponse.json({
            error: 'Processing error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }, { status: 500 })
    }
}