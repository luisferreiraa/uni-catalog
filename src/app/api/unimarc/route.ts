import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
})

async function fetchTemplates() {
    const res = await fetch('http://89.28.236.11:3000/api/definitions/templates', {
        method: 'GET',
        headers: {
            'X-API-Key': 'c6039a26-dca4-4c1b-a915-1e6cc388e842',
            'Content-Type': 'application/json',
        },
    })

    if (!res.ok) throw new Error('Failed to fetch templates')
    return await res.json()
}

export async function POST(req: NextRequest) {
    const { description, language = 'pt' } = await req.json()

    try {
        // 1. Obter templates disponíveis
        const templatesData = await fetchTemplates()
        const templates = templatesData.templates

        // 2. Preparar prompt inteligente
        const prompt = `
## Tarefa:
Você é um especialista em catalogação UNIMARC. Siga estas etapas:

1. ANALISE esta descrição bibliográfica: "${description}"
2. SELECIONE o template mais adequado dentre estas opções:
${templates.map(t => `- ${t.name} (${t.description})`).join('\n')}
3. PREENCHA os campos obrigatórios do template com dados extraídos ou inferidos
4. RETORNE um JSON com:
{
  "selectedTemplate": "Nome do template selecionado",
  "fields": {
    "tag": {
      "value": "Valor principal",
      "subfields": {
        "a": "Valor do subcampo a",
        "b": "Valor do subcampo b"
      },
      "indicators": ["0", "1"]
    }
  }
}

## Regras:
- Use apenas campos existentes no template selecionado
- Preencha TODOS os campos obrigatórios (mandatory=true)
- Idioma preferencial: ${language}
- Se faltar informação, use "[DADO NÃO ENCONTRADO]"
`

        // 3. Chamar OpenAI para processamento
        const completion = await openai.chat.completions.create({
            model: "gpt-4-1106-preview",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "Você é um catalogador UNIMARC especializado. Siga estritamente o formato solicitado."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.3
        })

        // 4. Processar a resposta
        const content = completion.choices[0]?.message?.content
        if (!content) throw new Error('Resposta vazia da OpenAI')

        const result = JSON.parse(content)

        // 5. Validar contra o template selecionado
        const selectedTemplate = templates.find(t => t.name === result.selectedTemplate)
        if (!selectedTemplate) throw new Error('Template selecionado é inválido')

        return NextResponse.json({
            template: selectedTemplate,
            ...result
        })

    } catch (error: any) {
        return NextResponse.json({
            error: 'Erro no processamento',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }, { status: 500 })
    }
}