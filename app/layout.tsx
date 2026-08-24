import { Analytics } from "@vercel/analytics/next"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: "Coverage Atlas | Medicaid Policy Intelligence",
  description: "Compare Medicaid coverage, access requirements, reimbursement, and policy changes across all 50 states.",
}

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f7f8fa",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="bg-background"><body className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}>{children}{process.env.NODE_ENV === "production" && <Analytics />}</body></html>
}
