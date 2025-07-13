'use client'
import { useState } from 'react'

export default function UnimarcCataloguer() {
  const [input, setInput] = useState('')
  const [language, setLanguage] = useState('pt')
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!input.trim()) {
      setError('Por favor, insira uma descrição')
      return
    }

    setLoading(true)
    setResult(null)
    setError(null)

    try {
      const response = await fetch('/api/unimarc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: input, language })
      })

      const data = await response.json()

      if (!response.ok) throw new Error(data.error || 'Erro desconhecido')

      setResult(data)
    } catch (err: any) {
      setError(err.message)
      console.error('Catalogation error:', err)
    } finally {
      setLoading(false)
    }
  }

  const renderField = (field: any) => {
    const translation = field.translations.find((t: any) => t.language === language) || field.translations[0]

    return (
      <div key={field.tag} className="mb-6 p-4 border rounded-lg bg-gray-50 text-black">
        <h3 className="font-bold mb-2">
          {field.tag} - {translation.name}
          {field.mandatory && <span className="ml-2 text-red-500">*</span>}
        </h3>

        {translation.tips && (
          <div className="text-sm text-gray-600 mb-3">
            {translation.tips.map((tip: string, i: number) => (
              <p key={i}>▪ {tip}</p>
            ))}
          </div>
        )}

        {result?.fields[field.tag] && (
          <div className="mt-3 text-black">
            <h4 className="text-sm font-semibold mb-1">Valores preenchidos:</h4>
            <div className="bg-white p-3 rounded border">
              {result.fields[field.tag].value && (
                <p className="mb-2">
                  <span className="font-medium">Valor principal:</span> {result.fields[field.tag].value}
                </p>
              )}

              {result.fields[field.tag].subfields && (
                <div>
                  <p className="font-medium mb-1 text-black">Subcampos:</p>
                  <ul className="list-disc pl-5">
                    {Object.entries(result.fields[field.tag].subfields).map(([code, value]) => (
                      <li key={code}>
                        <span className="font-mono">${code}</span>: {String(value)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="container mx-auto p-4 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Catalogação UNIMARC Inteligente</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          <div className="mb-4">
            <label className="block mb-2 font-medium">Descrição bibliográfica:</label>
            <textarea
              rows={6}
              className="w-full border rounded p-3"
              placeholder="Ex: Livro 'Ensaio sobre a Cegueira' de José Saramago, publicado pela Caminho em 1995"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="mb-4">
            <label className="block mb-2 font-medium">Idioma de catalogação:</label>
            <select
              className="border rounded p-2"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={loading}
            >
              <option value="pt">Português</option>
              <option value="en">Inglês</option>
            </select>
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Processando...' : 'Gerar Catalogação'}
          </button>
        </div>

        <div className="md:col-span-1">
          <h2 className="text-xl font-semibold mb-4">Templates Disponíveis</h2>
          <div className="space-y-3">
            {result?.template && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <h3 className="font-bold text-green-800">✓ {result.template.name}</h3>
                <p className="text-sm text-green-700">{result.template.description}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <h3 className="font-bold text-red-800">Erro</h3>
          <p className="text-red-700">{error}</p>
        </div>
      )}

      {result && (
        <div className="mt-8">
          <h2 className="text-xl font-semibold mb-4">
            Resultado: {result.selectedTemplate}
          </h2>

          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 text-black rounded-lg">
            <h3 className="font-bold mb-2">Resumo Automático</h3>
            <p>{input}</p>
          </div>

          <div className="space-y-4 text-white">
            <h3 className="font-bold">Campos de Controle</h3>
            {result.template.controlFields.map(renderField)}

            <h3 className="font-bold mt-6 text-white">Campos de Dados</h3>
            {result.template.dataFields.map(renderField)}
          </div>
        </div>
      )}
    </div>
  )
}