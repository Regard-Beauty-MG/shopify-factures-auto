// ============================================================================
//  Envoi automatique des factures - Paul Beuscher
//  Chaque soir (lance par GitHub Actions a 20h Paris) ce script :
//   1. recupere les commandes du jour sur Shopify
//   2. garde celles qui ont un email client (sinon -> ignore)
//   3. genere une facture PDF (format Paul Beuscher + TVA)
//   4. envoie la facture par email via Brevo
//   5. tag la commande "facture-envoyee" pour ne jamais la renvoyer
// ============================================================================

import PDFDocument from "pdfkit";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "logo-paul-beuscher.png");

// --- Configuration (vient des "Secrets" GitHub) ------------------------------
const SHOP = process.env.SHOP;                       // ex: paul-beuscher-2.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;     // token de la custom app Shopify
const BREVO_API_KEY = process.env.BREVO_API_KEY;     // cle API Brevo
const SENDER_EMAIL = process.env.SENDER_EMAIL || "dev@regardbeauty.com";
const SENDER_NAME = process.env.SENDER_NAME || "Paul Beuscher";
const API_VERSION = "2025-01";

// Coordonnees de la boutique affichees sur la facture (mêmes infos que le modèle Sufio)
const SHOP_INFO = {
  nom: "Paul Beuscher",
  adresse: "27 Boulevard Beaumarchais",
  cp_ville: "75004 Paris",
  pays: "France",
  siret: "FR96101496172",
  ape: "Code APE : 4763Z",
  contact: "dev@regardbeauty.com",
};

const DRY_RUN = process.env.DRY_RUN === "1"; // test sans envoyer ni taguer

// --- Petit garde-fou ---------------------------------------------------------
for (const [k, v] of Object.entries({ SHOP, SHOPIFY_TOKEN, BREVO_API_KEY })) {
  if (!v) {
    console.error(`Variable manquante: ${k}. Verifie les Secrets GitHub.`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
//  Plage horaire : "aujourd'hui" en heure de Paris (gere l'heure d'ete/hiver)
// ----------------------------------------------------------------------------
function plageDuJourParis() {
  const now = new Date();

  // Date du jour cote Paris (YYYY-MM-DD)
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  // Decalage UTC actuel de Paris : "GMT+2" (ete) ou "GMT+1" (hiver)
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName").value; // ex "GMT+2"
  const h = (tz.match(/GMT([+-]\d+)/) || [, "+0"])[1]; // "+2"
  const offset = `${h.startsWith("-") ? "-" : "+"}${String(
    Math.abs(parseInt(h, 10))
  ).padStart(2, "0")}:00`;

  const debut = `${ymd}T00:00:00${offset}`;   // minuit Paris
  const fin = now.toISOString();               // maintenant (heure du lancement ~20h)
  return { debut, fin, ymd };
}

// ----------------------------------------------------------------------------
//  Appel GraphQL Shopify
// ----------------------------------------------------------------------------
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) {
    throw new Error("Shopify GraphQL: " + JSON.stringify(json.errors));
  }
  return json.data;
}

// ----------------------------------------------------------------------------
//  Recupere toutes les commandes du jour qui n'ont pas encore ete facturees
// ----------------------------------------------------------------------------
async function commandesDuJour() {
  const { debut, fin } = plageDuJourParis();
  const q = `created_at:>='${debut}' created_at:<='${fin}' -tag:facture-envoyee source_name:pos`;

  const query = `
    query Orders($q: String!, $cursor: String) {
      orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            email
            createdAt
            sourceName
            paymentGatewayNames
            customer { firstName lastName }
            billingAddress { name address1 address2 zip city country }
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            taxLines { title ratePercentage priceSet { shopMoney { amount } } }
            lineItems(first: 100) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  originalUnitPriceSet { shopMoney { amount } }
                }
              }
            }
          }
        }
      }
    }`;

  const out = [];
  let cursor = null;
  do {
    const data = await shopifyGraphQL(query, { q, cursor });
    const page = data.orders;
    for (const e of page.edges) out.push(e.node);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return out;
}

// ----------------------------------------------------------------------------
//  Genere la facture PDF (retourne un Buffer)
// ----------------------------------------------------------------------------
function genererFacturePDF(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const devise = order.totalPriceSet.shopMoney.currencyCode || "EUR";
    const fmt = (n) =>
      new Intl.NumberFormat("fr-FR", { style: "currency", currency: devise }).format(
        Number(n)
      );
    const dateFr = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Europe/Paris",
    }).format(new Date(order.createdAt));

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // --- En-tete : "Facture" a gauche, logo Paul Beuscher a droite ---
    const topY = doc.y;
    doc.fontSize(22).font("Helvetica-Bold").fillColor("#000").text("Facture", left, topY);
    try {
      doc.image(LOGO_PATH, left + pageWidth - 150, topY - 8, { fit: [150, 45] });
    } catch (e) {
      console.warn("Logo introuvable, facture generee sans logo:", e.message);
    }
    doc.y = topY + 40;
    doc.moveDown();

    // --- Numero de facture + date d'emission ---
    const ligneMeta = (label, val) => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9).text(label, left, y, { width: 160 });
      doc.font("Helvetica").fontSize(9).text(val, left + 160, y);
      doc.moveDown(0.3);
    };
    ligneMeta("Numero de facture", order.name.replace("#", ""));
    ligneMeta("Date d'emission", dateFr);
    doc.moveDown();

    // --- Emetteur / Client, sur deux colonnes ---
    const colY = doc.y;
    const col2X = left + pageWidth / 2;

    doc.font("Helvetica-Bold").fontSize(9).text(SHOP_INFO.nom, left, colY);
    doc
      .font("Helvetica")
      .fontSize(9)
      .text(SHOP_INFO.adresse, left)
      .text(SHOP_INFO.cp_ville, left)
      .text(SHOP_INFO.pays, left)
      .text(SHOP_INFO.siret, left)
      .text(SHOP_INFO.ape, left);
    const finColGauche = doc.y;

    const c = order.customer || {};
    const nomClient =
      [c.firstName, c.lastName].filter(Boolean).join(" ") || order.billingAddress?.name || "";
    doc.y = colY;
    if (nomClient) doc.font("Helvetica-Bold").fontSize(9).text(nomClient, col2X, doc.y);
    doc.font("Helvetica").fontSize(9);
    if (order.billingAddress) {
      const b = order.billingAddress;
      [b.address1, b.address2, [b.zip, b.city].filter(Boolean).join(" "), b.country]
        .filter(Boolean)
        .forEach((l) => doc.text(l, col2X, doc.y));
    }
    if (order.email) doc.text(order.email, col2X, doc.y);

    doc.y = Math.max(finColGauche, doc.y) + 10;
    doc.moveDown();

    // --- Mode de paiement / Numero de commande ---
    ligneMeta("Mode de paiement", order.paymentGatewayNames?.[0] || "Non specifie");
    ligneMeta("Numero de commande", order.name);
    doc.moveDown();

    // --- Tableau des articles (en-tete noir, comme le modele Sufio) ---
    const colX = { article: left + 5, qte: left + pageWidth - 180, prix: left + pageWidth - 100 };
    let y = doc.y;
    doc.rect(left, y, pageWidth, 20).fill("#000");
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(8);
    doc.text("ARTICLE", colX.article, y + 6);
    doc.text("QUANTITE", colX.qte, y + 6, { width: 80, align: "center" });
    doc.text("PRIX UNITAIRE TTC", colX.prix, y + 6, { width: 100, align: "right" });
    y += 20;

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    for (const e of order.lineItems.edges) {
      const li = e.node;
      const total = Number(li.originalUnitPriceSet.shopMoney.amount) * li.quantity;
      doc.text(li.title, colX.article, y + 6, { width: colX.qte - colX.article - 10 });
      doc.text(String(li.quantity), colX.qte, y + 6, { width: 80, align: "center" });
      doc.text(fmt(total), colX.prix, y + 6, { width: 100, align: "right" });
      y += 20;
      doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#e5e5e5").stroke();
    }
    doc.y = y + 10;

    // --- Totaux (derniere ligne surlignee en gris, comme "Montant paye" sur Sufio) ---
    const ligneTotal = (label, val, surligne = false) => {
      const yT = doc.y;
      if (surligne) {
        doc.rect(left, yT - 3, pageWidth, 20).fill("#f0f0f0");
      }
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
      doc.text(label, left, yT + 3, { width: pageWidth - 105, align: "right" });
      doc.text(val, left + pageWidth - 100, yT + 3, { width: 100, align: "right" });
      doc.moveDown(1);
    };

    const totalHT =
      Number(order.currentSubtotalPriceSet.shopMoney.amount) -
      Number(order.totalTaxSet.shopMoney.amount);
    ligneTotal("Sous-total", fmt(order.currentSubtotalPriceSet.shopMoney.amount));
    ligneTotal("Total HT", fmt(totalHT));
    for (const t of order.taxLines) {
      const taux = t.ratePercentage != null ? ` ${t.ratePercentage}%` : "";
      ligneTotal(`TVA (${t.title})${taux}`, fmt(t.priceSet.shopMoney.amount));
    }
    ligneTotal("Total TTC", fmt(order.totalPriceSet.shopMoney.amount));
    ligneTotal("Montant paye", fmt(order.totalPriceSet.shopMoney.amount), true);

    // Pied de page
    doc.moveDown(2);
    doc
      .fontSize(8)
      .fillColor("gray")
      .font("Helvetica")
      .text(
        `Si vous avez des questions, veuillez envoyer un e-mail a ${SHOP_INFO.contact}`,
        left
      );

    doc.end();
  });
}

// ----------------------------------------------------------------------------
//  Envoie l'email avec la facture PDF en piece jointe (Brevo)
// ----------------------------------------------------------------------------
async function envoyerEmail(order, pdfBuffer) {
  const body = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: order.email }],
    subject: `Votre facture Paul Beuscher - commande ${order.name}`,
    htmlContent: `
      <p>Bonjour,</p>
      <p>Merci pour votre achat chez <strong>Paul Beuscher</strong>.</p>
      <p>Vous trouverez votre facture (commande ${order.name}) en piece jointe de cet email.</p>
      <p>A bientot,<br/>L'equipe Paul Beuscher</p>`,
    attachment: [
      {
        content: pdfBuffer.toString("base64"),
        name: `facture-${order.name.replace("#", "")}.pdf`,
      },
    ],
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Brevo ${res.status}: ${txt}`);
  }
}

// ----------------------------------------------------------------------------
//  Marque la commande comme facturee (tag) pour ne jamais la renvoyer
// ----------------------------------------------------------------------------
async function taguerCommande(orderId) {
  const mutation = `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`;
  const data = await shopifyGraphQL(mutation, {
    id: orderId,
    tags: ["facture-envoyee"],
  });
  const errs = data.tagsAdd.userErrors;
  if (errs && errs.length) throw new Error(JSON.stringify(errs));
}

// ----------------------------------------------------------------------------
//  Programme principal
// ----------------------------------------------------------------------------
async function main() {
  const { ymd } = plageDuJourParis();

  // Le workflow se declenche a 19h ET 20h UTC (pour couvrir ete + hiver).
  // On ne traite reellement qu'a 21h heure de Paris. Le lancement manuel
  // (bouton "Run workflow") passe toujours.
  const heureParis = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
    10
  );
  const manuel = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (!manuel && heureParis !== 21) {
    console.log(`Il est ${heureParis}h a Paris (pas 21h) -> on ne fait rien.`);
    return;
  }

  console.log(`=== Factures du ${ymd} (Paris) ===`);
  if (DRY_RUN) console.log("MODE TEST (DRY_RUN) : aucun email envoye, aucun tag pose.");

  const commandes = await commandesDuJour();
  console.log(`${commandes.length} commande(s) du jour a traiter.`);

  let envoyees = 0;
  let sautees = 0;
  let erreurs = 0;

  for (const order of commandes) {
    if (order.sourceName !== "pos") {
      sautees++;
      console.log(`- ${order.name} : source "${order.sourceName}" (pas POS) -> ignore`);
      continue;
    }
    if (!order.email) {
      sautees++;
      console.log(`- ${order.name} : pas d'email client -> ignore`);
      continue;
    }
    try {
      const pdf = await genererFacturePDF(order);
      if (DRY_RUN) {
        console.log(`- ${order.name} : [TEST] facture prete pour ${order.email}`);
      } else {
        await envoyerEmail(order, pdf);
        await taguerCommande(order.id);
        console.log(`- ${order.name} : facture envoyee a ${order.email}`);
      }
      envoyees++;
    } catch (e) {
      erreurs++;
      console.error(`- ${order.name} : ERREUR -> ${e.message}`);
    }
  }

  console.log(
    `\nResultat : ${envoyees} envoyee(s), ${sautees} sans email, ${erreurs} erreur(s).`
  );
  if (erreurs > 0) process.exit(1); // fait echouer le job GitHub si souci
}

main().catch((e) => {
  console.error("Echec global:", e);
  process.exit(1);
});
