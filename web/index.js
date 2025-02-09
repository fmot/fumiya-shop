// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

app.use("/api/*", shopify.validateAuthenticatedSession());

app.use(express.json());

app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });

  const countData = await client.request(`
    query shopifyProductCount {
      productsCount {
        count
      }
    }
  `);

  res.status(200).send({ count: countData.data.productsCount.count });
});

app.post("/api/products", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    console.log(`Failed to process products/create: ${e.message}`);
    status = 500;
    error = e.message;
  }
  res.status(status).send({ success: status === 200, error });
});

app.post("/api/update-price", async (req, res) => {
  console.log("Received request body:", req.body);

  const { productId, variantId, price } = req.body;

  if (!productId || !variantId || !price) {
    return res
      .status(400)
      .send({ error: "すべてのフィールドを入力してください。" });
  }

  try {
    const client = new shopify.api.clients.Graphql({
      session: res.locals.shopify.session,
    });

    console.log("Session Data:", res.locals.shopify.session);

    const response = await client.query({
      data: {
        query: `
          mutation variantsToBulkUpdate($productId: ID!, $variantsToBulkUpdate: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(
              productId: $productId
              variants: $variantsToBulkUpdate
            ) {
              userErrors {
                field
                message
              }
              product {
                id
              }
            }
          }
        `,
        variables: {
          productId: productId,
          variantsToBulkUpdate: [
            {
              id: variantId,
              price: price.toString(),
            },
          ],
        },
      },
    });

    console.log("GraphQL Response:", response.body);

    res.status(200).send({
      success: true,
      product: response.body.data.productVariantsBulkUpdate.product,
    });
  } catch (error) {
    if (error.response && error.response.body) {
      console.error(
        "GraphQL Error Details:",
        JSON.stringify(error.response.body, null, 2)
      );
    } else {
      console.error("Error:", error);
    }
    res.status(500).send({ error: "サーバーエラーが発生しました。" });
  }
});

// app.post("/api/update-product-title", async (req, res) => {
//   const { productId, newTitle } = req.body;

//   const UPDATE_PRODUCT_TITLE_MUTATION = `
//     mutation updateProductTitle($input: ProductInput!) {
//       productUpdate(input: $input) {
//         product {
//           id
//           title
//         }
//         userErrors {
//           field
//           message
//         }
//       }
//     }
//   `;

//   try {
//     const client = new shopify.api.clients.Graphql({
//       session: res.locals.shopify.session,
//     });

//     const response = await client.query({
//       data: {
//         query: UPDATE_PRODUCT_TITLE_MUTATION,
//         variables: {
//           input: {
//             id: productId,
//             title: newTitle,
//           },
//         },
//       },
//     });

//     if (response.body.data.productUpdate.userErrors.length > 0) {
//       res.status(400).send({
//         success: false,
//         errors: response.body.data.productUpdate.userErrors,
//       });
//     } else {
//       res.status(200).send({
//         success: true,
//         product: response.body.data.productUpdate.product,
//       });
//     }
//   } catch (error) {
//     console.error("Error updating product title:", error);
//     res.status(500).send({
//       success: false,
//       error: error.message,
//     });
//   }
// });

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

app.listen(PORT);
