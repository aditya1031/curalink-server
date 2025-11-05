import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import OpenAI from "openai";

dotenv.config();
const app = express();
const prisma = new PrismaClient();

// === Allowed frontend URLs
const allowedOrigins = [
  "https://curalink-frontend-gamma.vercel.app",
  "http://localhost:5173",
];

// === CORS Middleware
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // allow cookies/auth headers
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Handle preflight OPTIONS requests globally
app.options("*", cors({ origin: allowedOrigins, credentials: true }));

// === JSON parser
app.use(express.json());

/* ===================== AUTH ROUTES ===================== */

// REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password, gender, userType, fieldType, age, condition, allergies } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const validUserTypes = ["PATIENT", "RESEARCHER"];
    const validGenders = ["MALE", "FEMALE", "OTHER"];
    if (!validUserTypes.includes(userType)) return res.status(400).json({ error: "Invalid userType" });
    if (!validGenders.includes(gender)) return res.status(400).json({ error: "Invalid gender" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashed,
        gender,
        userType,
        fieldType: userType === "RESEARCHER" ? fieldType : null,
        age: userType === "PATIENT" ? Number(age) || null : null,
        condition: userType === "PATIENT" ? condition : null,
        allergies: userType === "PATIENT" ? allergies : null,
      },
    });

    res.status(201).json({ message: "Registered successfully", user });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email: user.email, userType: user.userType }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        userType: user.userType,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Fetch user by email
app.get("/api/patient/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.userType !== "PATIENT") return res.status(404).json({ error: "Patient not found" });
    res.json(user);
  } catch (err) {
    console.error("Fetch patient error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/researcher/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.userType !== "RESEARCHER") return res.status(404).json({ error: "Researcher not found" });
    res.json(user);
  } catch (err) {
    console.error("Fetch researcher error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===================== RESEARCH / DATA ROUTES ===================== */
// Example: PubMed
app.get("/api/patient-data/pubmed", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Missing query parameter" });
  try {
    const searchRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
      params: { db: "pubmed", term: query, retmode: "json", retmax: 10 },
      headers: { "User-Agent": "CuraLink/1.0 (mailto:test@example.com)" },
    });
    const ids = searchRes.data?.esearchresult?.idlist || [];
    if (!ids.length) return res.json({ results: [] });

    const summaryRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
      params: { db: "pubmed", id: ids.join(","), retmode: "json" },
      headers: { "User-Agent": "CuraLink/1.0 (mailto:test@example.com)" },
    });

    const all = summaryRes.data?.result || {};
    const papers = Object.keys(all)
      .filter((k) => k !== "uids")
      .map((key) => {
        const p = all[key];
        return { id: p.uid, title: p.title, journal: p.fulljournalname || p.source, pubDate: p.pubdate, authors: p.authors?.map((a) => a.name).join(", "), link: `https://pubmed.ncbi.nlm.nih.gov/${p.uid}/` };
      });

    res.json({ results: papers });
  } catch (err) {
    console.error("PubMed Error:", err.message);
    res.status(500).json({ error: "PubMed fetch failed" });
  }
});

/* ===================== AI SUMMARY ROUTE ===================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/ai-summary", async (req, res) => {
  const { symptoms } = req.body;
  if (!symptoms?.trim()) return res.status(400).json({ error: "Symptoms required" });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful medical research assistant." },
        { role: "user", content: `Summarize and provide research, trials, experts, next steps for: ${symptoms}` },
      ],
      max_tokens: 500,
    });

    const summary = response?.choices?.[0]?.message?.content || "No summary generated";
    res.json({ summary });
  } catch (err) {
    console.error("OpenAI Error:", err.message);
    res.status(500).json({ error: "OpenAI API call failed" });
  }
});

/* ===================== START SERVER ===================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
