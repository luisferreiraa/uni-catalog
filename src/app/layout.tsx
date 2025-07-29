import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Poppins } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

// Configurar a fonte Poppins
const poppins = Poppins({
  subsets: ["latin"],
  display: "swap", // Garante que a fonte seja exibida o mais rápido possível
  variable: "--font-poppins", // Define uma variável CSS para a fonte
  weight: ["400", "500", "600", "700"], // Define os pesos da fonte que deseja carregar
})

export const metadata: Metadata = {
  title: "Sistema de Catalogação UNIMARC",
  description: "Sistema otimizado para catalogação UNIMARC com IA",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt" className={`${poppins.variable}`}>
      <body className={inter.className}>{children}</body>
    </html>
  )
}

