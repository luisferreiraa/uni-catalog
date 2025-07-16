import type { TemplatesResponse } from "../app/types/unimarc"

class TemplateCache {
    private cache: Map<string, { data: TemplatesResponse; timestamp: number }> = new Map()
    private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutos

    async getTemplates(): Promise<TemplatesResponse> {
        const cacheKey = "templates"
        const cached = this.cache.get(cacheKey)

        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.data
        }

        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 8000)

            const res = await fetch("http://89.28.236.11:3000/api/definitions/templates", {
                method: "GET",
                headers: {
                    "X-API-Key": "c6039a26-dca4-4c1b-a915-1e6cc388e842",
                    "Content-Type": "application/json",
                },
                signal: controller.signal,
            })

            clearTimeout(timeout)

            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const data = await res.json()

            const validatedData: TemplatesResponse = {
                templates: Array.isArray(data.templates)
                    ? data.templates.filter(
                        (t: any) => t?.id && t?.name && Array.isArray(t.controlFields) && Array.isArray(t.dataFields),
                    )
                    : [],
            }

            this.cache.set(cacheKey, { data: validatedData, timestamp: Date.now() })
            return validatedData
        } catch (error) {
            console.error("Erro ao buscar templates:", error)
            return { templates: [] }
        }
    }

    clearCache(): void {
        this.cache.clear()
    }
}

export const templateCache = new TemplateCache()