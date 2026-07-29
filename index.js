const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require("stripe")(stripeSecretKey) : null;

function generateTrackingId() {
  const prefix = "PRCL";
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `${prefix}-${datePart}-${randomPart}`;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function buildMongoUri() {
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  const { DB_USER, DB_PASSWORD } = process.env;

  if (!DB_USER || !DB_PASSWORD) {
    throw new Error(
      "Missing MongoDB credentials. Set MONGODB_URI or DB_USER and DB_PASSWORD.",
    );
  }

  return `mongodb+srv://${DB_USER}:${DB_PASSWORD}@cluster0.1ezipje.mongodb.net/?appName=Cluster0`;
}

function requireStripeConfigured() {
  if (!stripe) {
    throw new Error("Missing STRIPE_SECRET_KEY.");
  }

  return stripe;
}

function requirePublicDomain() {
  if (!process.env.PAY_DOMAIN) {
    throw new Error("Missing PAY_DOMAIN.");
  }

  return process.env.PAY_DOMAIN.replace(/\/$/, "");
}

function validateObjectId(id) {
  return ObjectId.isValid(id);
}

function getParcelFilterFromQuery(query) {
  const filter = {};
  const email = query.email ?? query.senderEmail;

  if (email) {
    filter.senderEmail = email;
  }

  return filter;
}

function registerBaseMiddleware() {
  app.use(cors());
  app.use(express.json());
}

function registerHealthRoutes() {
  app.get("/", (req, res) => {
    res.send("Zap Is Shifting To The Cloud!");
  });

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });
}

function registerParcelRoutes(parcelCollection) {
  app.get(
    "/parcels",
    asyncRoute(async (req, res) => {
      const filter = getParcelFilterFromQuery(req.query);
      const parcels = await parcelCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(parcels);
    }),
  );

  app.post(
    "/parcels",
    asyncRoute(async (req, res) => {
      const parcel = req.body;

      if (!parcel || typeof parcel !== "object") {
        return res.status(400).json({ message: "Invalid parcel payload" });
      }

      const document = {
        ...parcel,
        createdAt: new Date(),
        paymentStatus: parcel.paymentStatus ?? "unpaid",
      };

      const result = await parcelCollection.insertOne(document);
      res.status(201).json(result);
    }),
  );

  app.get(
    "/parcels/:id",
    asyncRoute(async (req, res) => {
      const { id } = req.params;

      if (!validateObjectId(id)) {
        return res.status(400).json({ message: "Invalid parcel id" });
      }

      const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

      if (!parcel) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      res.json(parcel);
    }),
  );

  app.patch(
    "/parcels/:id",
    asyncRoute(async (req, res) => {
      const { id } = req.params;

      if (!validateObjectId(id)) {
        return res.status(400).json({ message: "Invalid parcel id" });
      }

      const updateParcel = req.body;

      if (!updateParcel || typeof updateParcel !== "object") {
        return res.status(400).json({ message: "Invalid parcel payload" });
      }

      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateParcel },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      res.json(result);
    }),
  );

  app.delete(
    "/parcels/:id",
    asyncRoute(async (req, res) => {
      const { id } = req.params;

      if (!validateObjectId(id)) {
        return res.status(400).json({ message: "Invalid parcel id" });
      }

      const result = await parcelCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      res.json(result);
    }),
  );
}

function registerPaymentRoutes(parcelCollection, paymentCollection) {
  app.get(
    "/payments",
    asyncRoute(async (req, res) => {
      const filter = {};

      if (req.query.email) {
        filter.customerEmail = req.query.email;
      }

      if (req.query.parcelId) {
        filter.parcelId = req.query.parcelId;
      }

      const payments = await paymentCollection
        .find(filter)
        .sort({ paidAt: -1 })
        .toArray();

      console.log("Payment history:", payments);

      res.json(payments);
    }),
  );

  app.post(
    "/payments",
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const amount = Number(body.amount);
      const parcelId = body.parcelId;
      const customerEmail = body.customerEmail;
      const transactionId = body.transactionId;
      const parcelName = body.parcelName ?? body.name ?? "";
      const paymentStatus = body.paymentStatus ?? "paid";
      const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
      const trackingId = body.trackingId || generateTrackingId();

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !parcelId ||
        !validateObjectId(parcelId) ||
        !customerEmail ||
        !transactionId ||
        !parcelName
      ) {
        return res.status(400).json({ message: "Invalid payment payload" });
      }

      if (paymentStatus !== "paid") {
        return res
          .status(400)
          .json({ message: "Payment must be marked as paid" });
      }

      const existingPayment = await paymentCollection.findOne({
        transactionId,
      });

      if (existingPayment) {
        return res.status(200).json(existingPayment);
      }

      const payment = {
        amount,
        currency: body.currency ?? "usd",
        customerEmail,
        parcelId,
        parcelName,
        transactionId,
        paymentStatus,
        paidAt,
        trackingId,
      };

      const result = await paymentCollection.insertOne(payment);

      return res.status(201).json({
        _id: result.insertedId,
        ...payment,
      });
    }),
  );

  app.post(
    "/create-checkout-session",
    asyncRoute(async (req, res) => {
      const stripeClient = requireStripeConfigured();
      const body = req.body ?? {};
      const parcelId = body.parcelId;
      const senderEmail = body.senderEmail ?? body.email ?? body.customerEmail;
      const parcelName = body.parcelName ?? body.name ?? body.title;
      const rawAmount = body.amount ?? body.cost ?? body.price;
      const amount = Number(rawAmount);

      if (
        !parcelId ||
        !senderEmail ||
        !parcelName ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({ message: "Invalid payment payload" });
      }

      const publicDomain = requirePublicDomain();

      const session = await stripeClient.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: Math.round(amount * 100),
              product_data: {
                name: parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: senderEmail,
        mode: "payment",
        metadata: {
          parcelId,
          parcelName,
          senderEmail,
        },
        success_url: `${publicDomain}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicDomain}/dashboard/payment-cancelled`,
      });

      return res.status(200).json({
        url: session.url,
        sessionId: session.id,
        parcelId,
      });
    }),
  );

  const handlePaymentSuccess = asyncRoute(async (req, res) => {
    const stripeClient = requireStripeConfigured();
    const sessionId = req.query.session_id ?? req.query.sessionId;

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ message: "Missing session_id" });
    }

    const session = await stripeClient.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res
        .status(409)
        .json({ success: false, message: "Payment not completed" });
    }

    const parcelId = session.metadata?.parcelId;

    if (!parcelId || !validateObjectId(parcelId)) {
      return res.status(400).json({ message: "Invalid parcel reference" });
    }

    const parcel = await parcelCollection.findOne({
      _id: new ObjectId(parcelId),
    });

    if (!parcel) {
      return res.status(404).json({ message: "Parcel not found" });
    }

    const trackingId = parcel.trackingId || generateTrackingId();
    const parcelName =
      session.metadata?.parcelName ?? parcel.parcelName ?? parcel.name ?? "";

    const parcelUpdateResult = await parcelCollection.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          paymentStatus: "paid",
          trackingId,
          updatedAt: new Date(),
        },
      },
    );

    const payment = {
      amount: (session.amount_total || 0) / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
      parcelId,
      parcelName,
      transactionId: session.payment_intent,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
      trackingId: trackingId,
    };

    let resultPayment = await paymentCollection.findOne({
      transactionId: session.payment_intent,
    });

    if (session.payment_status === "paid" && !resultPayment) {
      const insertResult = await paymentCollection.insertOne(payment);
      resultPayment = {
        _id: insertResult.insertedId,
        ...payment,
      };
    }

    return res.send({
      success: true,
      modifyParcel: parcelUpdateResult,
      trackingId: trackingId,
      transactionId: session.payment_intent,
      paymentInfo: resultPayment,
    });
  });

  app.get("/payment-success", handlePaymentSuccess);
  app.patch("/payment-success", handlePaymentSuccess);
}

function registerNotFoundHandler() {
  app.use((req, res) => {
    res.status(404).json({ message: "Route not found" });
  });
}

function registerErrorHandler() {
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ message: error.message || "Internal server error" });
  });
}

async function startServer() {
  registerBaseMiddleware();
  registerHealthRoutes();

  const client = new MongoClient(buildMongoUri(), {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });

  await client.connect();

  const db = client.db("zap_shift_DB");
  const parcelCollection = db.collection("parcels");
  const paymentCollection = db.collection("payments");

  registerParcelRoutes(parcelCollection);
  registerPaymentRoutes(parcelCollection, paymentCollection);
  registerNotFoundHandler();
  registerErrorHandler();

  await db.command({ ping: 1 });

  app.listen(port, () => {
    console.log(`Zap Shift server listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
