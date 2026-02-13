const axios = require("axios");
require("dotenv").config();

(async () => {
  const token = process.env.MP_ACCESS_TOKEN; // TEST- do vendedor

  if (!token) {
    console.log("ERRO: MP_ACCESS_TOKEN não está no .env");
    process.exit(1);
  }

  try {
    const res = await axios.post(
      "https://api.mercadopago.com/users/test_user",
      { site_id: "MLB" }, // Brasil
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("EMAIL:", res.data.email);
    console.log("SENHA (codigo):", res.data.password);
  } catch (e) {
    console.log("ERRO:", e?.response?.data || e.message);
  }
})();

