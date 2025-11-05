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

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173", credentials: true })); // change to your frontend URL

// ✅ REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      gender,
      userType,
      fieldType,
      age,
      condition,
      allergies,
    } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const validUserTypes = ["PATIENT", "RESEARCHER"];
    const validGenders = ["MALE", "FEMALE", "OTHER"];
    if (!validUserTypes.includes(userType))
      return res.status(400).json({ error: "Invalid userType" });
    if (!validGenders.includes(gender))
      return res.status(400).json({ error: "Invalid gender" });

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

// ✅ LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email, userType: user.userType },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

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

// ✅ FETCH USER BY EMAIL
app.get("/api/patient/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.userType !== "PATIENT")
      return res.status(404).json({ error: "Patient not found" });
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
    if (!user || user.userType !== "RESEARCHER")
      return res.status(404).json({ error: "Researcher not found" });
    res.json(user);
  } catch (err) {
    console.error("Fetch researcher error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === 🔬 Research Data APIs ===

// 🧠 PubMed
app.get("/api/patient-data/pubmed", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Missing query parameter" });

  try {
    // 1️⃣ Get IDs
    const searchUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
    const searchRes = await axios.get(searchUrl, {
      params: {
        db: "pubmed",
        term: query,
        retmode: "json",
        retmax: 10,
      },
      headers: { "User-Agent": "CuraLink/1.0 (mailto:test@example.com)" },
    });

    const ids = searchRes.data?.esearchresult?.idlist || [];
    if (ids.length === 0) return res.json({ results: [] });

    // 2️⃣ Get summaries
    const summaryUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
    const summaryRes = await axios.get(summaryUrl, {
      params: {
        db: "pubmed",
        id: ids.join(","),
        retmode: "json",
      },
      headers: { "User-Agent": "CuraLink/1.0 (mailto:test@example.com)" },
    });

    // 3️⃣ Parse and format
    const all = summaryRes.data?.result || {};
    const papers = Object.keys(all)
      .filter((k) => k !== "uids")
      .map((key) => {
        const p = all[key];
        return {
          id: p.uid,
          title: p.title,
          journal: p.fulljournalname || p.source,
          pubDate: p.pubdate,
          authors: p.authors?.map((a) => a.name).join(", "),
          link: `https://pubmed.ncbi.nlm.nih.gov/${p.uid}/`,
        };
      });

    res.json({ results: papers });
  } catch (err) {
    console.error("❌ PubMed Error:", err.response?.status, err.message);
    res.status(500).json({ error: "PubMed fetch failed" });
  }
});

// 🧬 Clinical Trials

// === Clinical Trials (Enhanced API Fetch) ===
app.get("/api/patient-data/trials", async (req, res) => {
  try {
    const condition = req.query.condition || "cancer";
    const { data } = await axios.get(
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(
        condition
      )}&pageSize=5`
    );

    const studies = data?.studies || [];

    const results = studies.map((s) => {
      const id = s.protocolSection?.identificationModule?.nctId;
      const title =
        s.protocolSection?.identificationModule?.briefTitle ||
        s.protocolSection?.identificationModule?.officialTitle ||
        "Untitled Trial";

      const status =
        s.protocolSection?.statusModule?.overallStatus || "Status Unknown";

      const conditions =
        s.protocolSection?.conditionsModule?.conditions?.join(", ") ||
        "Condition not specified";

      const locations =
        s.protocolSection?.contactsLocationsModule?.locations
          ?.map((loc) => loc.facility?.name)
          .join(", ") || "No locations listed";

      return {
        id,
        title,
        status,
        condition: conditions,
        location: locations,
        url: `https://clinicaltrials.gov/study/${id}`,
      };
    });

    res.json({ results });
  } catch (err) {
    console.error("❌ Clinical Trials error:", err.message);
    res.status(500).json({ error: "Failed to fetch Clinical Trials" });
  }
});



// 🧾 ORCID (Full researcher details)
app.get("/api/patient-data/orcid", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    const searchUrl = `https://pub.orcid.org/v3.0/search/?q=${encodeURIComponent(name)}`;
    console.log("🔍 Searching ORCID:", searchUrl);

    const searchRes = await axios.get(searchUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CuraLink/1.0 (mailto:test@example.com)",
      },
    });

    const results = searchRes.data?.result || [];
    if (results.length === 0) return res.json({ result: [] });

    const detailed = [];

    // limit to first 5 for speed
    for (const r of results.slice(0, 5)) {
      const id = r["orcid-identifier"]?.path;
      if (!id) continue;

      const profileUrl = `https://pub.orcid.org/v3.0/${id}`;
      const { data: profile } = await axios.get(profileUrl, {
        headers: { Accept: "application/json" },
      });

      const given = profile?.person?.name?.["given-names"]?.value || "";
      const family = profile?.person?.name?.["family-name"]?.value || "";
      const bio = profile?.person?.biography?.content || "";
      const works = profile?.activities_summary?.works?.group?.slice(0, 3)?.map((w) => {
        const title = w?.["work-summary"]?.[0]?.title?.title?.value;
        const year = w?.["work-summary"]?.[0]?.["publication-date"]?.year?.value;
        return { title, year };
      });

      detailed.push({
        id,
        name: `${given} ${family}`.trim(),
        biography: bio,
        works: works || [],
        link: `https://orcid.org/${id}`,
      });
    }

    res.json({ result: detailed });
  } catch (err) {
    console.error("❌ ORCID Error:", err.response?.data || err.message);
    res.status(500).json({ error: "ORCID fetch failed" });
  }
});


// 🎓 Google Scholar (SerpApi Integration)
app.get("/api/patient-data/scholar", async (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.status(400).json({ error: "Missing topic" });

  try {
    const { data } = await axios.get(
      `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
        topic
      )}&api_key=c8a9ee87ac89a4215640128df12f96153040f319f62dc9384d86f18904b46bd1`
    );

    res.json(data?.organic_results || []);
  } catch (err) {
    console.error("❌ Scholar Error:", err.message);
    res.status(500).json({ error: "Scholar fetch failed" });
  }
});

// 🧩 ResearchGate (SerpAPI)
app.get("/api/patient-data/researchgate", async (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.status(400).json({ error: "Missing topic" });

  try {
    const { data } = await axios.get(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
        topic
      )}+site:researchgate.net&api_key=c8a9ee87ac89a4215640128df12f96153040f319f62dc9384d86f18904b46bd1`
    );

    const results = data.organic_results?.map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));

    res.json({ results: results || [] });
  } catch (err) {
    console.error("❌ ResearchGate Error:", err.message);
    res.json({ results: [] });
  }
});


/* ---------------------- 🧠 RESEARCH DASHBOARD ROUTES ---------------------- */
// === Research Papers (Europe PMC API – working) ===
app.get("/api/research-data/papers", async (req, res) => {
  try {
    const topic = req.query.topic || "oncology";

    const { data } = await axios.get(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search`,
      {
        params: { query: topic, format: "json", pageSize: 5 },
      }
    );

    const results = (data.resultList?.result || []).map((p) => ({
      title: p.title,
      authors: p.authorString || "Unknown authors",
      link: p.fullTextUrlList?.fullTextUrl?.[0]?.url || `https://europepmc.org/article/${p.source}/${p.id}`,
    }));

    res.json({ results });
  } catch (err) {
    console.error("❌ Papers API Error:", err.message);
    res.status(500).json({ error: "Failed to fetch papers" });
  }
});

// === Collaborations (Semantic Scholar API) ===
app.get("/api/research-data/collaborations", async (req, res) => {
  try {
    const query = req.query.query || "AI research";
    const { data } = await axios.get(
      `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(
        query
      )}&limit=5`
    );

    const results = (data.data || []).map((c) => ({
      name: c.name,
      institution: c.affiliations?.[0] || "Unknown",
      id: c.authorId,
    }));

    res.json({ results });
  } catch (err) {
    console.error("❌ Collaboration API Error:", err.message);
    res.status(500).json({ error: "Failed to fetch collaborations" });
  }
});


// === 🧬 Research Grants (Stable NIH API with fallbacks) ===
app.get("/api/research-data/grants", async (req, res) => {
  try {
    const query = req.query.query || "cancer";

    const { data } = await axios.post(
      "https://api.reporter.nih.gov/v2/projects/search",
      {
        criteria: { text: query },
        include_fields: [
          "project_num",
          "project_title",
          "agency",
          "award_amount",
          "organization.org_name",
          "principal_investigators.pi_name",
        ],
        offset: 0,
        limit: 6,
      }
    );

    const results =
      data?.results?.map((g, index) => ({
        id: g.project_num || `grant-${index}`,
        title: g.project_title?.trim() || `${query} Research Grant`,
        agency: g.agency || "NIH",
        organization: g.organization?.org_name || "Unknown Organization",
        pi: g.principal_investigators?.[0]?.pi_name || "Unknown PI",
        amount: g.award_amount
          ? `$${Number(g.award_amount).toLocaleString()}`
          : "Not disclosed",
        url: g.project_num
          ? `https://reporter.nih.gov/project-details/${g.project_num}`
          : "#",
      })) || [];

    res.json({ results });
  } catch (err) {
    console.error("❌ Grants API Error:", err.message);
    res.status(500).json({ error: "Failed to fetch grants data" });
  }
});


// === 🧠 AI Summary Endpoint ===
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
app.post("/api/ai-summary", async (req, res) => {
  const { symptoms } = req.body;
  if (!symptoms?.trim()) return res.status(400).json({ error: "Symptoms required" });

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Missing OpenAI API key");
    return res.status(500).json({ error: "OpenAI API key not set" });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful medical research assistant." },
        { role: "user", content: `Summarize and provide research, trials, experts, next steps for: ${symptoms}` },
      ],
      max_tokens: 500,
    });

    const summary = response?.choices?.[0]?.message?.content || null;
    if (!summary) {
      console.error("❌ OpenAI returned empty summary", response);
      return res.status(500).json({ error: "OpenAI did not return a summary" });
    }

    res.json({ summary });
  } catch (err) {
    const response = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",
  messages: [{ role: "user", content: "Say hello" }],
  max_tokens: 50,
});
console.log(response.choices[0].message.content);
  }
});

// ✅ SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
