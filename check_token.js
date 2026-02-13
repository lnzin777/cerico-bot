// create_test_buyer.js
require("dotenv").config();
const axios = require("axios");
const TEST_MODE = true; // <-- enquanto estiver true, não chama Mercado Pago

(async () => {
  const token = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("Faltou MP_ACCESS_TOKEN no .env");

  const r = await axios.post(
    "https://api.mercadopago.com/users/test_user",
    {
      site_id: "MLB",
      description: "buyer test user",
    },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }
  );

  const u = r.data;

  console.log("EMAIL:", u.email);
  console.log("PASSWORD:", u.password);

  // ✅ aqui sai o doc se vier no retorno
  const docType = u?.identification?.type;
  const docNumber = u?.identification?.number;

  console.log("DOC_TYPE:", docType || "(não veio)");
  console.log("DOC_NUMBER:", docNumber || "(não veio)");
})();
