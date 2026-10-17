const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// firebase-admin v12+ uses the modular API. The old `admin.credential.cert()`
// namespace no longer exists and crashed the server on startup.
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
require("dotenv").config();

/* -------------------------------------------------------------------------- */
/*                                   Setup                                    */
/* -------------------------------------------------------------------------- */

function loadServiceAccount() {
  // For deployment, the key can be provided as a base64 string in FB_SERVICE_KEY
  if (process.env.FB_SERVICE_KEY) {
    return JSON.parse(
      Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8"),
    );
  }

  return require("./zap-shift-856c0-firebase-adminsdk-fbsvc-9bdb6a7acd.json");
}

initializeApp({ credential: cert(loadServiceAccount()) });

const app = express();
const port = process.env.PORT || 3000;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require("stripe")(stripeSecretKey) : null;

const ROLES = {
  USER: "user",
  RIDER: "rider",
  ADMIN: "admin",
};

// Delivery progress only. Payment is tracked separately in paymentStatus
// ("unpaid" | "paid"), so a parcel can move forward whether it is paid or not.
const PARCEL_STATUS = {
  PENDING: "pending", // booked, waiting for a rider to accept
  READY_TO_PICKUP: "ready-to-pickup",
  IN_TRANSIT: "in-transit",
  REACHED_SERVICE_CENTER: "reached-service-center",
  SHIPPED: "shipped",
  READY_FOR_DELIVERY: "ready-for-delivery",
  DELIVERED: "delivered",
};

const RIDER_EARNING_PER_TASK = 20;

// Parcel costs are in taka (BDT). Stripe charges in USD, so the cost is
// converted with this rate. Set BDT_PER_USD in .env to change it.
const BDT_PER_USD = Number(process.env.BDT_PER_USD) || 120;
// Stripe does not accept USD charges below $0.50
const STRIPE_MIN_USD_CENTS = 50;

// Filled in startServer() once MongoDB is connected
const collections = {};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function generateTrackingId() {
  const prefix = "PRCL";
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `${prefix}-${datePart}-${randomPart}`;
}

// 4 digit code the receiver gives the rider at the door. The sender sees it
// on their parcel; riders never do.
function generateDeliveryCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

// Wrong delivery codes allowed before the admin has to confirm the delivery
const MAX_DELIVERY_CODE_ATTEMPTS = 5;

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function validateObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSameDistrict(parcel) {
  return parcel.senderDistrict === parcel.receiverDistrict;
}

// Same pricing rules as the client (readme420.md). Computed on the server so
// the cost cannot be tampered with from the browser.
function calculateCost({ parcelType, parcelWeight, senderDistrict, receiverDistrict }) {
  const sameDistrict = senderDistrict === receiverDistrict;

  if (parcelType === "document") {
    return sameDistrict ? 60 : 80;
  }

  const weight = Number(parcelWeight) || 0;
  const baseCharge = sameDistrict ? 110 : 150;

  if (weight <= 3) {
    return baseCharge;
  }

  const extraWeight = weight - 3;
  const extraCharge = sameDistrict
    ? extraWeight * 40
    : extraWeight * 40 + 40;

  return Math.round((baseCharge + extraCharge) * 100) / 100;
}

function bdtToUsdCents(amountBdt) {
  return Math.max(
    STRIPE_MIN_USD_CENTS,
    Math.round((Number(amountBdt) / BDT_PER_USD) * 100),
  );
}

function canAccessParcel(user, parcel) {
  const email = normalizeEmail(user.email);

  return (
    user.role === ROLES.ADMIN ||
    normalizeEmail(parcel.senderEmail) === email ||
    normalizeEmail(parcel.pickupRider?.email) === email ||
    normalizeEmail(parcel.deliveryRider?.email) === email
  );
}

async function logTracking(parcel, status, message, updatedBy) {
  await collections.trackings.insertOne({
    trackingId: parcel.trackingId,
    parcelId: parcel._id.toString(),
    parcelName: parcel.parcelName,
    senderEmail: parcel.senderEmail,
    status,
    message,
    updatedBy: updatedBy || "system",
    createdAt: new Date(),
  });
}

async function findParcelOr404(id, res) {
  if (!validateObjectId(id)) {
    res.status(400).json({ success: false, message: "Invalid parcel id" });
    return null;
  }

  const parcel = await collections.parcels.findOne({ _id: new ObjectId(id) });

  if (!parcel) {
    res.status(404).json({ success: false, message: "Parcel not found" });
    return null;
  }

  return parcel;
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

/* -------------------------------------------------------------------------- */
/*                         Admin account & OTP helpers                        */
/* -------------------------------------------------------------------------- */

const GENDERS = ["male", "female", "other"];

function cleanText(value, max = 100) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isValidPhone(value) {
  return /^\+?[0-9][0-9\s-]{5,19}$/.test(value);
}

function cleanPhotoUrl(value) {
  const url = cleanText(value, 500);
  return /^https:\/\//i.test(url) ? url : "";
}

/* -------------------------------------------------------------------------- */
/*                                Middlewares                                 */
/* -------------------------------------------------------------------------- */

/**
 * Firebase Token Verification Middleware
 * - Verifies the Firebase ID token sent as "Authorization: Bearer <token>"
 * - Attaches { uid, email, provider } to req.user
 * Returns: 401 if token missing or invalid
 */
const verifyFBToken = asyncRoute(async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Missing authorization token",
    });
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: normalizeEmail(decodedToken.email),
      name: decodedToken.name || "",
      picture: decodedToken.picture || "",
      // "password" or "google.com"
      provider: decodedToken.firebase?.sign_in_provider,
    };

    if (!req.user.email) {
      return res.status(401).json({ success: false, message: "Unauthorized: Account has no email" });
    }

    next();
  } catch (firebaseError) {
    console.error("[AUTH] Token verification failed:", firebaseError.code);

    return res.status(401).json({
      success: false,
      message:
        firebaseError.code === "auth/id-token-expired"
          ? "Unauthorized: Token expired"
          : "Unauthorized: Invalid token",
    });
  }
});

/**
 * Loads the user's profile from the users collection.
 * - 403 PROFILE_NOT_FOUND when the Firebase account never registered
 */
const attachProfile = asyncRoute(async (req, res, next) => {
  const profile = await collections.users.findOne({ email: req.user.email });

  if (!profile) {
    return res.status(403).json({
      success: false,
      code: "PROFILE_NOT_FOUND",
      message: "No ZapShift account found for this login. Please register first.",
    });
  }

  req.user.profile = profile;
  req.user.role = profile.role || ROLES.USER;

  next();
});

// Every protected route: valid Firebase token + registered profile
const verifyUser = [verifyFBToken, attachProfile];

// Each role includes the ones below it:
// an admin can also act as a rider and a user, a rider also as a user.
const ROLE_LEVEL = {
  [ROLES.USER]: 1,
  [ROLES.RIDER]: 2,
  [ROLES.ADMIN]: 3,
};

function hasRole(user, minimumRole) {
  return (ROLE_LEVEL[user.role] || 0) >= ROLE_LEVEL[minimumRole];
}

/**
 * Role-Based Access Middleware (use after verifyUser)
 * Usage: app.get("/route", verifyUser, verifyRole("rider"), handler)
 * Lets through the given role and every role above it.
 * Returns: 403 if the user's role is lower
 */
const verifyRole = (minimumRole) => (req, res, next) => {
  if (hasRole(req.user, minimumRole)) {
    return next();
  }

  console.warn(
    `[AUTHZ] ${req.user.email} (${req.user.role}) blocked from ${req.method} ${req.path}`,
  );
  return res.status(403).json({
    success: false,
    message: "Forbidden: You do not have access to this resource",
  });
};

const verifyAdmin = verifyRole(ROLES.ADMIN);
const verifyRider = verifyRole(ROLES.RIDER);

const rateLimitMessage = {
  success: false,
  message: "Too many attempts. Please wait a few minutes and try again.",
};

// Login / register / email checks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: rateLimitMessage,
});

// Public endpoints without login: contact form and parcel tracking
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: rateLimitMessage,
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  // Fixing a typo in the form must not use up the allowance
  skipFailedRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "You have sent several messages already. Please wait a while before sending another.",
  },
});

function registerBaseMiddleware() {
  const corsOptions = {
    // CLIENT_URL can be a comma separated list. When missing, the request
    // origin is reflected (fine for local development).
    origin: process.env.CLIENT_URL
      ? process.env.CLIENT_URL.split(",").map((url) => url.trim())
      : true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 3600,
  };

  // Vercel (and most hosts) sit in front of the app as a proxy
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

function registerHealthRoutes() {
  app.get("/", (req, res) => {
    res.send("Zap Is Shifting To The Cloud!");
  });

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Lets the client show the same BDT -> USD conversion Stripe will charge
  app.get("/exchange-rate", (req, res) => {
    res.json({
      bdtPerUsd: BDT_PER_USD,
      minUsd: STRIPE_MIN_USD_CENTS / 100,
    });
  });
}

/* -------------------------------------------------------------------------- */
/*                               Admin access                                 */
/* -------------------------------------------------------------------------- */
//
// Simple rule:
// - No admin in the database: whoever asks becomes the admin.
// - Otherwise the request goes to the admins, and an admin approves or rejects it.
//
// admin_requests: { email, uid, name, photoURL, provider, currentRole,
//   status: "pending" | "approved" | "rejected", reason,
//   requestedAt, reviewedAt, reviewedBy, firstAdmin }

async function adminExists() {
  return (await collections.users.countDocuments({ role: ROLES.ADMIN }, { limit: 1 })) > 0;
}

// Only one account can become the first admin, even if two ask at once
async function claimFirstAdmin(profile) {
  if (await adminExists()) return false;

  // A lock older than a minute is left over from an admin that was removed
  await collections.system.deleteOne({
    _id: "first-admin",
    claimedAt: { $lt: new Date(Date.now() - 60 * 1000) },
  });

  try {
    await collections.system.insertOne({
      _id: "first-admin",
      email: profile.email,
      claimedAt: new Date(),
    });
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }

  await collections.users.updateOne(
    { _id: profile._id },
    { $set: { role: ROLES.ADMIN, roleUpdatedAt: new Date() } },
  );
  await collections.adminRequests.updateOne(
    { email: profile.email },
    {
      $set: {
        status: "approved",
        firstAdmin: true,
        reviewedAt: new Date(),
        reviewedBy: "system (first admin)",
      },
      $setOnInsert: {
        email: profile.email,
        uid: profile.uid,
        name: profile.name,
        requestedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return true;
}

function publicRequest(request) {
  if (!request) return null;
  return {
    status: request.status,
    reason: request.reason || "",
    requestedAt: request.requestedAt,
    reviewedAt: request.reviewedAt || null,
  };
}

function registerAuthRoutes() {
  // Register page: is this email already used? (profile or Firebase account)
  app.post(
    "/auth/check-email",
    authLimiter,
    asyncRoute(async (req, res) => {
      const email = normalizeEmail(req.body?.email);

      if (!/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ success: false, message: "Enter a valid email" });
      }

      let exists = !!(await collections.users.findOne(
        { email },
        { projection: { _id: 1 } },
      ));

      if (!exists) {
        try {
          await getAuth().getUserByEmail(email);
          exists = true;
        } catch (error) {
          if (error.code !== "auth/user-not-found") throw error;
        }
      }

      res.json({ success: true, exists });
    }),
  );

  // Create the profile for a newly created Firebase account.
  // Every new account starts with the "user" role. One profile per email.
  app.post(
    "/auth/register",
    authLimiter,
    verifyFBToken,
    asyncRoute(async (req, res) => {
      const { email, uid } = req.user;
      const body = req.body ?? {};

      const existing = await collections.users.findOne(
        { email },
        { projection: { _id: 1 } },
      );

      if (existing) {
        return res.status(409).json({
          success: false,
          code: "USER_EXISTS",
          message: "An account with this email already exists. Please log in.",
        });
      }

      const phone = cleanText(body.phone, 20);
      if (phone && !isValidPhone(phone)) {
        return res.status(400).json({ success: false, message: "Enter a valid phone number" });
      }

      const now = new Date();
      const user = {
        email,
        uid,
        name: cleanText(body.name, 60) || req.user.name || email.split("@")[0],
        photoURL: cleanPhotoUrl(body.photoURL) || req.user.picture || "",
        phone,
        gender: GENDERS.includes(body.gender) ? body.gender : "",
        role: ROLES.USER,
        riderStatus: "none",
        // Registered from the "Rider" tab: the app sends them to the rider application
        wantsToRide: body.accountType === "rider",
        signUpMethod: req.user.provider === "google.com" ? "google" : "password",
        createdAt: now,
        lastLoginAt: now,
      };

      try {
        const result = await collections.users.insertOne(user);
        user._id = result.insertedId;
      } catch (error) {
        // Unique index on email: a parallel request already created it
        if (error.code === 11000) {
          return res.status(409).json({
            success: false,
            code: "USER_EXISTS",
            message: "An account with this email already exists. Please log in.",
          });
        }
        throw error;
      }

      res.status(201).json({ success: true, data: user });
    }),
  );

  // Only registered accounts can log in
  app.post(
    "/auth/login",
    authLimiter,
    verifyFBToken,
    asyncRoute(async (req, res) => {
      const user = await collections.users.findOne({ email: req.user.email });

      if (!user) {
        return res.status(404).json({
          success: false,
          code: "USER_NOT_FOUND",
          message: "No account found for this email. Please register first.",
        });
      }

      await collections.users.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date(), uid: req.user.uid } },
      );

      res.json({ success: true, data: user });
    }),
  );

  // Current account status, used by the client on every page load
  app.get(
    "/auth/me",
    verifyFBToken,
    asyncRoute(async (req, res) => {
      const user = await collections.users.findOne({ email: req.user.email });

      if (!user) {
        return res.json({ success: true, exists: false, role: null });
      }

      res.json({
        success: true,
        exists: true,
        role: user.role,
        riderStatus: user.riderStatus || "none",
        wantsToRide: !!user.wantsToRide,
      });
    }),
  );

  // Admin access page: is there an admin yet, and what happened to my request?
  app.get(
    "/auth/admin/request",
    verifyUser,
    asyncRoute(async (req, res) => {
      const request = await collections.adminRequests.findOne({ email: req.user.email });
      res.json({
        success: true,
        role: req.user.role,
        hasAdmin: await adminExists(),
        request: publicRequest(request),
      });
    }),
  );

  // Become admin: no admin yet -> you are the admin now.
  // Otherwise -> a pending request for the admins.
  app.post(
    "/auth/admin/request",
    authLimiter,
    verifyUser,
    asyncRoute(async (req, res) => {
      const profile = req.user.profile;

      if (profile.role === ROLES.ADMIN) {
        return res.json({ success: true, state: "admin" });
      }

      if (await claimFirstAdmin(profile)) {
        console.log(`[ADMIN] ${profile.email} became the first admin.`);
        return res.json({ success: true, state: "admin", firstAdmin: true });
      }

      const existing = await collections.adminRequests.findOne({ email: profile.email });

      // New request, or asking again after a rejection
      if (existing?.status !== "pending") {
        await collections.adminRequests.updateOne(
          { email: profile.email },
          {
            $set: {
              email: profile.email,
              uid: req.user.uid,
              name: profile.name,
              photoURL: profile.photoURL || "",
              provider: req.user.provider,
              currentRole: profile.role,
              status: "pending",
              reason: "",
              requestedAt: new Date(),
            },
            $unset: { reviewedAt: "", reviewedBy: "", firstAdmin: "" },
          },
          { upsert: true },
        );
      }

      const request = await collections.adminRequests.findOne({ email: profile.email });
      res.json({ success: true, state: "pending", request: publicRequest(request) });
    }),
  );
}

function registerAdminRequestRoutes() {
  // Admin: admin access requests (default: waiting for a decision)
  app.get(
    "/admin/requests",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const status = ["pending", "approved", "rejected"].includes(req.query.status)
        ? req.query.status
        : "pending";
      const requests = await collections.adminRequests
        .find({ status })
        .sort({ requestedAt: -1 })
        .limit(200)
        .toArray();

      res.json({ success: true, count: requests.length, data: requests });
    }),
  );

  // Admin: approve -> the account becomes an admin. Reject -> reason is shown
  app.patch(
    "/admin/requests/:id",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { id } = req.params;
      const { status } = req.body ?? {};
      const reason = cleanText(req.body?.reason, 300);

      if (!validateObjectId(id)) {
        return res.status(400).json({ success: false, message: "Invalid request id" });
      }
      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be 'approved' or 'rejected'",
        });
      }

      const request = await collections.adminRequests.findOne({ _id: new ObjectId(id) });

      if (!request || request.status !== "pending") {
        return res.status(409).json({
          success: false,
          message: "This request is not waiting for a decision",
        });
      }

      const user = await collections.users.findOne({ email: request.email });

      if (!user) {
        return res.status(404).json({ success: false, message: "This account no longer exists" });
      }

      await collections.adminRequests.updateOne(
        { _id: request._id },
        {
          $set: {
            status,
            reason: status === "rejected" ? reason || "Your request was not approved." : "",
            reviewedAt: new Date(),
            reviewedBy: req.user.email,
          },
        },
      );

      if (status === "approved") {
        // A rider keeps their rider profile and can still take deliveries
        await collections.users.updateOne(
          { _id: user._id },
          { $set: { role: ROLES.ADMIN, roleUpdatedAt: new Date() } },
        );
      }

      res.json({ success: true, status });
    }),
  );
}

function registerUserRoutes() {
  // Profile page: the user's record plus a summary of their activity
  app.get(
    "/users/me",
    verifyUser,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const [statusRows, paymentRows, rider, unpaidCount] = await Promise.all([
        collections.parcels
          .aggregate([
            { $match: { senderEmail: email } },
            { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } },
          ])
          .toArray(),
        collections.payments
          .aggregate([
            { $match: { customerEmail: email } },
            {
              $group: {
                _id: null,
                totalBdt: { $sum: "$amount" },
                count: { $sum: 1 },
                lastPaidAt: { $max: "$paidAt" },
              },
            },
          ])
          .toArray(),
        collections.riders.findOne({ email }),
        collections.parcels.countDocuments({ senderEmail: email, paymentStatus: { $ne: "paid" } }),
      ]);

      const byStatus = Object.fromEntries(
        statusRows.map((row) => [row._id, row.count]),
      );
      const totalParcels = statusRows.reduce((sum, row) => sum + row.count, 0);

      res.json({
        success: true,
        data: {
          user: req.user.profile,
          rider,
          stats: {
            totalParcels,
            delivered: byStatus.delivered || 0,
            unpaid: unpaidCount,
            inProgress: totalParcels - (byStatus.delivered || 0),
            totalSpentBdt: paymentRows[0]?.totalBdt || 0,
            paymentCount: paymentRows[0]?.count || 0,
            lastPaidAt: paymentRows[0]?.lastPaidAt || null,
          },
        },
      });
    }),
  );

  // Update your own profile. Role and email can never be changed here.
  app.patch(
    "/users/me",
    verifyUser,
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const update = { updatedAt: new Date() };

      if (body.name !== undefined) {
        const name = cleanText(body.name, 60);
        if (!name) {
          return res.status(400).json({ success: false, message: "Name is required" });
        }
        update.name = name;
      }
      if (body.photoURL !== undefined) {
        update.photoURL = cleanPhotoUrl(body.photoURL);
      }
      if (body.phone !== undefined) {
        const phone = cleanText(body.phone, 20);
        if (phone && !isValidPhone(phone)) {
          return res.status(400).json({ success: false, message: "Enter a valid phone number" });
        }
        update.phone = phone;
      }
      if (body.gender !== undefined) {
        if (body.gender && !GENDERS.includes(body.gender)) {
          return res.status(400).json({ success: false, message: "Invalid gender" });
        }
        update.gender = body.gender || "";
      }

      await collections.users.updateOne({ email: req.user.email }, { $set: update });
      const user = await collections.users.findOne({ email: req.user.email });

      res.json({ success: true, data: user });
    }),
  );

  // Admin: list users, search by name / email / phone, filter by role
  app.get(
    "/users",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const filter = {};

      if (req.query.search) {
        const pattern = { $regex: escapeRegex(req.query.search.trim()), $options: "i" };
        filter.$or = [{ email: pattern }, { name: pattern }, { phone: pattern }];
      }
      if (Object.values(ROLES).includes(req.query.role)) {
        filter.role = req.query.role;
      }

      const users = await collections.users
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

      res.json({ success: true, count: users.length, data: users });
    }),
  );
}

function registerRiderRoutes() {
  // Any registered customer can apply to be a rider
  app.post(
    "/riders",
    verifyUser,
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const profile = req.user.profile;

      if (profile.role === ROLES.RIDER || profile.riderStatus === "approved") {
        return res.status(409).json({ success: false, message: "You are already a rider" });
      }

      const required = [
        "name",
        "phone",
        "region",
        "district",
        "nid",
        "drivingLicense",
        "bikeModel",
        "bikeRegistration",
      ];
      const missing = required.filter(
        (field) => typeof body[field] !== "string" || !body[field].trim(),
      );

      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `Missing fields: ${missing.join(", ")}`,
        });
      }
      if (!isValidPhone(body.phone.trim())) {
        return res.status(400).json({ success: false, message: "Enter a valid phone number" });
      }

      const existing = await collections.riders.findOne({
        email: req.user.email,
      });

      if (existing && existing.status !== "rejected") {
        return res.status(409).json({
          success: false,
          message: `You already have a rider application (${existing.status}).`,
        });
      }

      const application = {
        email: req.user.email,
        name: cleanText(body.name, 60),
        phone: cleanText(body.phone, 20),
        age: Number(body.age) || null,
        region: cleanText(body.region, 60),
        district: cleanText(body.district, 60),
        nid: cleanText(body.nid, 30),
        drivingLicense: cleanText(body.drivingLicense, 30),
        bikeModel: cleanText(body.bikeModel, 80),
        bikeRegistration: cleanText(body.bikeRegistration, 30),
        about: cleanText(body.about, 500),
        status: "pending",
        earnings: existing?.earnings ?? 0,
        appliedAt: new Date(),
        rejectionReason: "",
      };

      await collections.riders.updateOne(
        { email: req.user.email },
        { $set: application },
        { upsert: true },
      );

      // Mirror the status on the profile so it shows everywhere
      await collections.users.updateOne(
        { email: req.user.email },
        {
          $set: { riderStatus: "pending", riderAppliedAt: application.appliedAt },
          $unset: { riderRejectionReason: "" },
        },
      );

      res.status(201).json({ success: true, data: application });
    }),
  );

  // The current user's own rider application / rider profile
  app.get(
    "/riders/me",
    verifyUser,
    asyncRoute(async (req, res) => {
      const rider = await collections.riders.findOne({ email: req.user.email });
      res.json({ success: true, data: rider });
    }),
  );

  // Admin: list rider applications, optionally by status
  app.get(
    "/riders",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const filter = {};

      if (["pending", "approved", "rejected"].includes(req.query.status)) {
        filter.status = req.query.status;
      }

      const riders = await collections.riders
        .find(filter)
        .sort({ appliedAt: -1 })
        .toArray();

      res.json({ success: true, count: riders.length, data: riders });
    }),
  );

  // Admin: approved riders working in a district (used to assign parcels)
  app.get(
    "/riders/available",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const filter = { status: "approved" };

      if (req.query.district) {
        filter.district = req.query.district;
      }

      const riders = await collections.riders.find(filter).toArray();
      res.json({ success: true, count: riders.length, data: riders });
    }),
  );

  // Admin: approve / reject a rider.
  // Approved -> role "rider". Rejected -> role "user" + reason on the profile.
  app.patch(
    "/riders/:id/status",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { id } = req.params;
      const { status } = req.body ?? {};
      const reason = cleanText(req.body?.reason, 300);

      if (!validateObjectId(id)) {
        return res.status(400).json({ success: false, message: "Invalid rider id" });
      }
      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be 'approved' or 'rejected'",
        });
      }

      const rider = await collections.riders.findOne({ _id: new ObjectId(id) });

      if (!rider) {
        return res.status(404).json({ success: false, message: "Rider not found" });
      }

      const user = await collections.users.findOne({ email: rider.email });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "This applicant no longer has an account",
        });
      }
      const now = new Date();

      await collections.riders.updateOne(
        { _id: rider._id },
        {
          $set: {
            status,
            reviewedAt: now,
            reviewedBy: req.user.email,
            rejectionReason: status === "rejected" ? reason : "",
          },
        },
      );

      // An admin keeps the admin role; only the rider status changes
      const isAdmin = user.role === ROLES.ADMIN;
      await collections.users.updateOne(
        { _id: user._id },
        status === "approved"
          ? {
              $set: {
                riderStatus: "approved",
                ...(isAdmin ? {} : { role: ROLES.RIDER, roleUpdatedAt: now }),
              },
              $unset: { riderRejectionReason: "" },
            }
          : {
              $set: {
                riderStatus: "rejected",
                riderRejectionReason: reason || "Your application did not meet our requirements.",
                ...(isAdmin ? {} : { role: ROLES.USER, roleUpdatedAt: now }),
              },
            },
      );

      res.json({ success: true, status });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                        Rider requests (auto dispatch)                       */
/* -------------------------------------------------------------------------- */
//
// parcel.riderRequest = {
//   type: "pickup" | "delivery",
//   district,                      // where riders were searched
//   riders: [{ email, name, phone, district }],  // riders who got the request
//   declinedBy: [email],
//   status: "open" | "accepted" | "assigned" | "declined" | "no-riders",
//   createdAt, respondedAt, acceptedBy
// }
// "open" requests can be accepted by any listed rider; the first accept wins.
// "no-riders" / "declined" mean the admin has to assign a rider by hand.

function riderSummary(rider) {
  return {
    email: rider.email,
    name: rider.name,
    phone: rider.phone,
    district: rider.district,
  };
}

// Customers and riders never see which other riders were asked.
// Only the sender (and admins) see the delivery code.
function parcelForViewer(parcel, user) {
  if (user.role === ROLES.ADMIN) return parcel;

  const view = { ...parcel };
  if (normalizeEmail(parcel.senderEmail) !== normalizeEmail(user.email)) {
    delete view.deliveryCode;
  }
  delete view.deliveryCodeAttempts;
  delete view.checkoutSessionId;
  if (parcel.riderRequest) {
    view.riderRequest = {
      type: parcel.riderRequest.type,
      status: parcel.riderRequest.status,
    };
  }
  // Part-time riders: which admin assigned them is internal
  for (const field of ["pickupRider", "deliveryRider"]) {
    if (view[field]?.assignedBy) {
      const { assignedBy: _assignedBy, ...rider } = view[field];
      view[field] = rider;
    }
  }
  return view;
}

// Send a pickup / delivery request to every approved rider in the district
async function dispatchRiderRequest(parcel, type, { exclude = [] } = {}) {
  const district = type === "pickup" ? parcel.senderDistrict : parcel.receiverDistrict;
  const riders = await collections.riders
    .find(
      { status: "approved", district, email: { $nin: exclude } },
      { projection: { email: 1, name: 1, phone: 1, district: 1 } },
    )
    .toArray();

  const riderRequest = {
    type,
    district,
    riders: riders.map(riderSummary),
    declinedBy: [],
    status: riders.length ? "open" : "no-riders",
    createdAt: new Date(),
  };

  await collections.parcels.updateOne({ _id: parcel._id }, { $set: { riderRequest } });
  return riderRequest;
}

// What confirming a pickup / delivery does to the parcel
function confirmStep(parcel, action) {
  if (action === "pickup") {
    const sameDistrict = isSameDistrict(parcel);
    return {
      riderField: "pickupRider",
      from: PARCEL_STATUS.READY_TO_PICKUP,
      next: sameDistrict ? PARCEL_STATUS.READY_FOR_DELIVERY : PARCEL_STATUS.IN_TRANSIT,
      message: sameDistrict
        ? "Parcel picked up by rider, out for delivery"
        : "Parcel picked up by rider, on the way to service center",
      timeField: "pickedUpAt",
    };
  }
  if (action === "delivery") {
    return {
      riderField: "deliveryRider",
      from: PARCEL_STATUS.READY_FOR_DELIVERY,
      next: PARCEL_STATUS.DELIVERED,
      message: "Parcel delivered successfully",
      timeField: "deliveredAt",
    };
  }
  return null;
}

// Fields to set when a rider takes the pickup or delivery job
function assignmentUpdate(parcel, type, riderInfo) {
  if (type === "pickup") {
    return {
      pickupRider: riderInfo,
      // Within the same district the pickup rider also delivers the parcel
      ...(isSameDistrict(parcel) ? { deliveryRider: riderInfo } : {}),
      deliveryStatus: PARCEL_STATUS.READY_TO_PICKUP,
    };
  }
  return {
    deliveryRider: riderInfo,
    deliveryStatus: PARCEL_STATUS.READY_FOR_DELIVERY,
  };
}

function registerParcelRoutes() {
  // Your own parcels. Admins can ask for every parcel with ?all=1
  app.get(
    "/parcels",
    verifyUser,
    asyncRoute(async (req, res) => {
      const { deliveryStatus, paymentStatus, search } = req.query;
      const filter = {};
      const allParcels = req.query.all === "1" && hasRole(req.user, ROLES.ADMIN);

      if (!allParcels) {
        filter.senderEmail = req.user.email;
      } else if (req.query.email) {
        filter.senderEmail = normalizeEmail(req.query.email);
      }

      if (Object.values(PARCEL_STATUS).includes(deliveryStatus)) {
        filter.deliveryStatus = deliveryStatus;
      }
      if (["paid", "unpaid"].includes(paymentStatus)) {
        filter.paymentStatus = paymentStatus;
      }
      if (search) {
        const pattern = { $regex: escapeRegex(search.trim()), $options: "i" };
        filter.$or = [
          { trackingId: pattern },
          { receiverContact: pattern },
          { parcelName: pattern },
        ];
      }

      const parcels = await collections.parcels
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(parcels.map((parcel) => parcelForViewer(parcel, req.user)));
    }),
  );

  // Book a parcel. It is saved whether it is paid now or later, gets its
  // tracking id right away, and riders in the pickup district get a request.
  app.post(
    "/parcels",
    verifyUser,
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const requiredFields = [
        "parcelType",
        "parcelName",
        "senderName",
        "senderPhone",
        "senderAddress",
        "senderRegion",
        "senderDistrict",
        "receiverName",
        "receiverContact",
        "receiverAddress",
        "receiverRegion",
        "receiverDistrict",
      ];
      const missing = requiredFields.filter(
        (field) => typeof body[field] !== "string" || !body[field].trim(),
      );

      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `Missing required fields: ${missing.join(", ")}`,
        });
      }
      if (!["document", "not-document"].includes(body.parcelType)) {
        return res.status(400).json({ success: false, message: "Invalid parcel type" });
      }

      const parcelWeight = Number(body.parcelWeight) || 0;

      if (body.parcelType === "not-document" && parcelWeight <= 0) {
        return res.status(400).json({
          success: false,
          message: "Parcel weight is required for non-document parcels",
        });
      }

      const pick = (field) =>
        typeof body[field] === "string" ? body[field].trim() : "";

      const parcel = {
        parcelType: body.parcelType,
        parcelName: pick("parcelName"),
        parcelWeight,
        senderName: pick("senderName"),
        // Always the logged in user, never trusted from the request body
        senderEmail: req.user.email,
        senderPhone: pick("senderPhone"),
        senderAddress: pick("senderAddress"),
        senderRegion: pick("senderRegion"),
        senderDistrict: pick("senderDistrict"),
        pickupInstruction: pick("pickupInstruction"),
        receiverName: pick("receiverName"),
        receiverEmail: normalizeEmail(body.receiverEmail),
        receiverContact: pick("receiverContact"),
        receiverAddress: pick("receiverAddress"),
        receiverRegion: pick("receiverRegion"),
        receiverDistrict: pick("receiverDistrict"),
        deliveryInstruction: pick("deliveryInstruction"),
        trackingId: generateTrackingId(),
        deliveryCode: generateDeliveryCode(),
        paymentStatus: "unpaid",
        deliveryStatus: PARCEL_STATUS.PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      parcel.cost = calculateCost(parcel);

      const result = await collections.parcels.insertOne(parcel);
      parcel._id = result.insertedId;

      await logTracking(
        parcel,
        PARCEL_STATUS.PENDING,
        "Parcel booked. Looking for a rider near the pickup address",
        req.user.email,
      );
      const riderRequest = await dispatchRiderRequest(parcel, "pickup");

      res.status(201).json({
        success: true,
        insertedId: result.insertedId,
        trackingId: parcel.trackingId,
        deliveryCode: parcel.deliveryCode,
        cost: parcel.cost,
        ridersNotified: riderRequest.riders.length,
      });
    }),
  );

  app.get(
    "/parcels/:id",
    verifyUser,
    asyncRoute(async (req, res) => {
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      if (!canAccessParcel(req.user, parcel)) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: You do not have access to this parcel",
        });
      }

      res.json(parcelForViewer(parcel, req.user));
    }),
  );

  // Owners can delete an unpaid parcel until a rider takes it.
  // Admins can delete any parcel.
  app.delete(
    "/parcels/:id",
    verifyUser,
    asyncRoute(async (req, res) => {
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const isAdmin = req.user.role === ROLES.ADMIN;

      if (!isAdmin && parcel.senderEmail !== req.user.email) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      if (!isAdmin && parcel.paymentStatus === "paid") {
        return res.status(400).json({
          success: false,
          message: "Paid parcels cannot be deleted",
        });
      }
      if (!isAdmin && parcel.deliveryStatus !== PARCEL_STATUS.PENDING) {
        return res.status(400).json({
          success: false,
          message: "A rider is already handling this parcel, so it can't be deleted",
        });
      }

      const result = await collections.parcels.deleteOne({ _id: parcel._id });
      await collections.trackings.deleteMany({ parcelId: parcel._id.toString() });
      res.json(result);
    }),
  );

  /* ----------------------------- Admin workflow ---------------------------- */

  // Assign or change the pickup / delivery rider by hand:
  // - any approved app rider:  { type, riderEmail }
  // - a part-time rider without the app: { type, partTime: { name, phone } }
  //   The admin confirms their pickup / delivery (see confirm-step below).
  app.patch(
    "/parcels/:id/assign-rider",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { riderEmail, type, partTime } = req.body ?? {};
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      if (!["pickup", "delivery"].includes(type)) {
        return res.status(400).json({ success: false, message: "Type must be pickup or delivery" });
      }

      let riderInfo;
      if (partTime) {
        const name = cleanText(partTime.name, 60);
        const phone = cleanText(partTime.phone, 20);
        if (!name || !isValidPhone(phone)) {
          return res.status(400).json({
            success: false,
            message: "Enter the part-time rider's name and a valid phone number",
          });
        }
        riderInfo = { name, phone, partTime: true, assignedBy: req.user.email };
      } else {
        const rider = await collections.riders.findOne({
          email: normalizeEmail(riderEmail),
          status: "approved",
        });

        if (!rider) {
          return res.status(400).json({ success: false, message: "Approved rider not found" });
        }
        riderInfo = riderSummary(rider);
      }

      // Before the pickup happens the pickup rider can be set or changed;
      // before delivery the delivery rider can be set or changed.
      const allowedStatuses =
        type === "pickup"
          ? [PARCEL_STATUS.PENDING, PARCEL_STATUS.READY_TO_PICKUP]
          : [PARCEL_STATUS.SHIPPED, PARCEL_STATUS.READY_FOR_DELIVERY];

      const previous = type === "pickup" ? parcel.pickupRider : parcel.deliveryRider;
      const update = {
        ...assignmentUpdate(parcel, type, riderInfo),
        "riderRequest.status": "assigned",
        "riderRequest.respondedAt": new Date(),
        updatedAt: new Date(),
      };

      const result = await collections.parcels.updateOne(
        { _id: parcel._id, deliveryStatus: { $in: allowedStatuses } },
        { $set: update },
      );

      if (result.matchedCount === 0) {
        return res.status(409).json({
          success: false,
          message:
            type === "pickup"
              ? "The pickup rider can only be set before the parcel is picked up"
              : "The delivery rider can only be set after the parcel is shipped",
        });
      }

      // Remember part-time riders so the admin can pick them again
      if (riderInfo.partTime) {
        await collections.partTimeRiders.updateOne(
          { phone: riderInfo.phone },
          {
            $set: { name: riderInfo.name, lastAssignedAt: new Date() },
            $setOnInsert: { phone: riderInfo.phone, addedBy: req.user.email, createdAt: new Date() },
            $inc: { assignments: 1 },
          },
          { upsert: true },
        );
      }

      const who = `${riderInfo.partTime ? "part-time rider" : "rider"} ${riderInfo.name}`;
      const message = previous
        ? `${type === "pickup" ? "Pickup" : "Delivery"} rider changed to ${who}`
        : `${who.charAt(0).toUpperCase()}${who.slice(1)} assigned to ${type === "pickup" ? "pick up" : "deliver"} the parcel`;

      await logTracking(parcel, update.deliveryStatus, message, req.user.email);
      res.json({ success: true, deliveryStatus: update.deliveryStatus });
    }),
  );

  // Remove the assigned rider. The parcel goes back to waiting and the
  // request is sent again to the other riders in the district.
  app.patch(
    "/parcels/:id/remove-rider",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { type } = req.body ?? {};
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      let filter;
      let unset;
      let nextStatus;
      let removed;

      if (type === "pickup") {
        removed = parcel.pickupRider;
        filter = { _id: parcel._id, deliveryStatus: PARCEL_STATUS.READY_TO_PICKUP };
        unset = isSameDistrict(parcel)
          ? { pickupRider: "", deliveryRider: "" }
          : { pickupRider: "" };
        nextStatus = PARCEL_STATUS.PENDING;
      } else if (type === "delivery") {
        if (isSameDistrict(parcel)) {
          return res.status(400).json({
            success: false,
            message: "In the same district the pickup rider delivers. Use 'Change rider' instead.",
          });
        }
        removed = parcel.deliveryRider;
        filter = { _id: parcel._id, deliveryStatus: PARCEL_STATUS.READY_FOR_DELIVERY };
        unset = { deliveryRider: "" };
        nextStatus = PARCEL_STATUS.SHIPPED;
      } else {
        return res.status(400).json({ success: false, message: "Type must be pickup or delivery" });
      }

      const result = await collections.parcels.updateOne(filter, {
        $set: { deliveryStatus: nextStatus, updatedAt: new Date() },
        $unset: unset,
      });

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: `There is no ${type} rider to remove at this stage`,
        });
      }

      await logTracking(
        parcel,
        nextStatus,
        `${type === "pickup" ? "Pickup" : "Delivery"} rider removed. Finding a new rider`,
        req.user.email,
      );
      const riderRequest = await dispatchRiderRequest(parcel, type, {
        exclude: removed?.email ? [removed.email] : [],
      });

      res.json({
        success: true,
        deliveryStatus: nextStatus,
        ridersNotified: riderRequest.riders.length,
      });
    }),
  );

  // The admin confirms a pickup / delivery on the rider's behalf: always for
  // part-time riders (no app), and for app riders when they can't (phone
  // died, receiver lost the delivery code, too many wrong codes).
  app.patch(
    "/parcels/:id/confirm-step",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const step = confirmStep(parcel, req.body?.action);
      if (!step) {
        return res.status(400).json({ success: false, message: "Action must be pickup or delivery" });
      }

      const rider = parcel[step.riderField];
      const result = await collections.parcels.updateOne(
        {
          _id: parcel._id,
          deliveryStatus: step.from,
          [step.riderField]: { $exists: true },
        },
        { $set: { deliveryStatus: step.next, [step.timeField]: new Date(), updatedAt: new Date() } },
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: "There is no rider on this step, or it was already confirmed",
        });
      }

      if (rider.partTime) {
        await collections.partTimeRiders.updateOne(
          { phone: rider.phone },
          { $inc: { completedTasks: 1 } },
        );
      } else {
        await collections.riders.updateOne(
          { email: rider.email },
          { $inc: { earnings: RIDER_EARNING_PER_TASK, completedTasks: 1 } },
        );
      }
      await logTracking(
        parcel,
        step.next,
        `${step.message} (${rider.partTime ? "part-time rider" : "rider"} ${rider.name}, confirmed by admin)`,
        req.user.email,
      );

      res.json({ success: true, deliveryStatus: step.next });
    }),
  );

  // Part-time riders used before, to pick one again quickly
  app.get(
    "/admin/part-time-riders",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const riders = await collections.partTimeRiders
        .find({})
        .sort({ lastAssignedAt: -1 })
        .limit(50)
        .toArray();
      res.json({ success: true, count: riders.length, data: riders });
    }),
  );

  // Send the rider request again (e.g. after new riders were approved)
  app.post(
    "/parcels/:id/dispatch",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const type =
        parcel.deliveryStatus === PARCEL_STATUS.PENDING
          ? "pickup"
          : parcel.deliveryStatus === PARCEL_STATUS.SHIPPED
            ? "delivery"
            : null;

      if (!type) {
        return res.status(409).json({
          success: false,
          message: "This parcel already has a rider for its current step",
        });
      }

      const riderRequest = await dispatchRiderRequest(parcel, type);
      res.json({ success: true, ridersNotified: riderRequest.riders.length, riderRequest });
    }),
  );

  // Admin-only status moves for inter-district parcels
  app.patch(
    "/parcels/:id/status",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { status } = req.body ?? {};
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const reachedMessage = `Parcel reached ${parcel.senderDistrict} service center`;
      const transitions = {
        [PARCEL_STATUS.REACHED_SERVICE_CENTER]: {
          from: [PARCEL_STATUS.IN_TRANSIT],
          message: reachedMessage,
        },
        // From in-transit this is "receive & ship" in one click
        [PARCEL_STATUS.SHIPPED]: {
          from: [PARCEL_STATUS.IN_TRANSIT, PARCEL_STATUS.REACHED_SERVICE_CENTER],
          message: `Parcel shipped to ${parcel.receiverDistrict} service center`,
        },
      };
      const transition = transitions[status];

      if (!transition) {
        return res.status(400).json({ success: false, message: "Invalid status change" });
      }

      const result = await collections.parcels.updateOne(
        { _id: parcel._id, deliveryStatus: { $in: transition.from } },
        { $set: { deliveryStatus: status, updatedAt: new Date() } },
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: `Parcel must be '${transition.from.join("' or '")}' first`,
        });
      }

      // Skipped the separate "received" click: keep that step in the timeline
      if (
        status === PARCEL_STATUS.SHIPPED &&
        parcel.deliveryStatus === PARCEL_STATUS.IN_TRANSIT
      ) {
        await logTracking(parcel, PARCEL_STATUS.REACHED_SERVICE_CENTER, reachedMessage, req.user.email);
      }
      await logTracking(parcel, status, transition.message, req.user.email);

      // Shipped: ask the riders at the destination to deliver it
      let ridersNotified;
      if (status === PARCEL_STATUS.SHIPPED) {
        ridersNotified = (await dispatchRiderRequest(parcel, "delivery")).riders.length;
      }

      res.json({ success: true, deliveryStatus: status, ridersNotified });
    }),
  );
}

function registerRiderTaskRoutes() {
  // Open pickup / delivery requests sent to this rider
  app.get(
    "/rider/requests",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const parcels = await collections.parcels
        .find({
          "riderRequest.status": "open",
          "riderRequest.riders.email": email,
          "riderRequest.declinedBy": { $ne: email },
          deliveryStatus: { $in: [PARCEL_STATUS.PENDING, PARCEL_STATUS.SHIPPED] },
        })
        .sort({ "riderRequest.createdAt": -1 })
        .toArray();

      res.json({
        success: true,
        count: parcels.length,
        data: parcels.map((parcel) => parcelForViewer(parcel, req.user)),
      });
    }),
  );

  // Accept a request. The first rider to accept gets the job.
  app.patch(
    "/rider/requests/:id/accept",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const type = parcel.riderRequest?.type;
      const rider = await collections.riders.findOne({ email, status: "approved" });

      if (!type || !rider) {
        return res.status(409).json({ success: false, message: "This request is no longer available" });
      }

      const update = {
        ...assignmentUpdate(parcel, type, riderSummary(rider)),
        "riderRequest.status": "accepted",
        "riderRequest.acceptedBy": email,
        "riderRequest.respondedAt": new Date(),
        updatedAt: new Date(),
      };

      // Atomic: only matches while the request is still open for this rider
      const result = await collections.parcels.updateOne(
        {
          _id: parcel._id,
          "riderRequest.type": type,
          "riderRequest.status": "open",
          "riderRequest.riders.email": email,
          "riderRequest.declinedBy": { $ne: email },
          deliveryStatus: type === "pickup" ? PARCEL_STATUS.PENDING : PARCEL_STATUS.SHIPPED,
        },
        { $set: update },
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: "Another rider already accepted this request, or it was cancelled",
        });
      }

      await logTracking(
        parcel,
        update.deliveryStatus,
        type === "pickup"
          ? `Rider ${rider.name} accepted the pickup`
          : `Rider ${rider.name} accepted the delivery`,
        email,
      );

      res.json({ success: true, type, deliveryStatus: update.deliveryStatus });
    }),
  );

  // Decline a request. If every rider declines, the admin is alerted.
  app.patch(
    "/rider/requests/:id/decline",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const result = await collections.parcels.updateOne(
        {
          _id: parcel._id,
          "riderRequest.status": "open",
          "riderRequest.riders.email": email,
        },
        { $addToSet: { "riderRequest.declinedBy": email } },
      );

      if (result.matchedCount === 0) {
        return res.status(409).json({ success: false, message: "This request is no longer open" });
      }

      const updated = await collections.parcels.findOne(
        { _id: parcel._id },
        { projection: { riderRequest: 1 } },
      );
      const request = updated.riderRequest;

      if (request.declinedBy.length >= request.riders.length) {
        await collections.parcels.updateOne(
          { _id: parcel._id, "riderRequest.status": "open" },
          { $set: { "riderRequest.status": "declined", "riderRequest.respondedAt": new Date() } },
        );
      }

      res.json({ success: true });
    }),
  );

  // type=pickup | delivery | completed
  app.get(
    "/rider/parcels",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const filters = {
        pickup: {
          "pickupRider.email": email,
          deliveryStatus: PARCEL_STATUS.READY_TO_PICKUP,
        },
        delivery: {
          "deliveryRider.email": email,
          deliveryStatus: PARCEL_STATUS.READY_FOR_DELIVERY,
        },
        completed: {
          "deliveryRider.email": email,
          deliveryStatus: PARCEL_STATUS.DELIVERED,
        },
      };
      const filter = filters[req.query.type] || filters.pickup;

      const parcels = await collections.parcels
        .find(filter)
        .sort({ updatedAt: -1 })
        .toArray();

      res.json({
        success: true,
        count: parcels.length,
        data: parcels.map((parcel) => parcelForViewer(parcel, req.user)),
      });
    }),
  );

  // Rider confirms a pickup (one tap, the sender is handing the parcel over)
  // or a delivery (the receiver tells the rider the 4 digit delivery code).
  app.patch(
    "/rider/parcels/:id/confirm",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const { action } = req.body ?? {};
      const parcel = await findParcelOr404(req.params.id, res);
      if (!parcel) return;

      const email = req.user.email;
      const step = confirmStep(parcel, action);

      if (!step) {
        return res.status(400).json({ success: false, message: "Action must be pickup or delivery" });
      }
      if (normalizeEmail(parcel[step.riderField]?.email) !== email) {
        return res.status(403).json({ success: false, message: "This parcel is not assigned to you" });
      }
      if (parcel.deliveryStatus !== step.from) {
        return res.status(409).json({ success: false, message: "This parcel was already updated" });
      }

      if (action === "delivery") {
        const attempts = parcel.deliveryCodeAttempts || 0;
        if (attempts >= MAX_DELIVERY_CODE_ATTEMPTS) {
          return res.status(423).json({
            success: false,
            code: "CODE_LOCKED",
            message: "Too many wrong codes. Call the admin to confirm this delivery.",
          });
        }

        const given = String(req.body?.code ?? "").trim().toUpperCase();
        // Parcels booked before delivery codes existed use the tracking id
        const expected = String(parcel.deliveryCode || parcel.trackingId).toUpperCase();

        if (!given || given !== expected) {
          await collections.parcels.updateOne(
            { _id: parcel._id },
            { $inc: { deliveryCodeAttempts: 1 } },
          );
          const left = MAX_DELIVERY_CODE_ATTEMPTS - attempts - 1;
          return res.status(400).json({
            success: false,
            message:
              left > 0
                ? `Wrong delivery code. ${left} attempt${left === 1 ? "" : "s"} left.`
                : "Wrong delivery code. Call the admin to confirm this delivery.",
          });
        }
      }

      const result = await collections.parcels.updateOne(
        {
          _id: parcel._id,
          [`${step.riderField}.email`]: email,
          deliveryStatus: step.from,
        },
        { $set: { deliveryStatus: step.next, [step.timeField]: new Date(), updatedAt: new Date() } },
      );

      if (result.modifiedCount === 0) {
        return res.status(409).json({
          success: false,
          message: "This parcel is not assigned to you or was already updated",
        });
      }

      await collections.riders.updateOne(
        { email },
        { $inc: { earnings: RIDER_EARNING_PER_TASK, completedTasks: 1 } },
      );
      await logTracking(parcel, step.next, step.message, email);

      res.json({ success: true, deliveryStatus: step.next });
    }),
  );
}

function registerTrackingRoutes() {
  // Latest tracking updates for the logged in user's parcels
  app.get(
    "/trackings",
    verifyUser,
    asyncRoute(async (req, res) => {
      const trackings = await collections.trackings
        .find({ senderEmail: req.user.email })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();

      res.json({ success: true, count: trackings.length, data: trackings });
    }),
  );

  // Full timeline for one tracking id
  app.get(
    "/trackings/:trackingId",
    verifyUser,
    asyncRoute(async (req, res) => {
      const trackingId = String(req.params.trackingId).trim().toUpperCase();
      const parcel = await collections.parcels.findOne({ trackingId });

      if (!parcel) {
        return res.status(404).json({ success: false, message: "No parcel found with this tracking ID" });
      }
      if (!canAccessParcel(req.user, parcel)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }

      const history = await collections.trackings
        .find({ trackingId })
        .sort({ createdAt: 1 })
        .toArray();

      res.json({ success: true, parcel: parcelForViewer(parcel, req.user), history });
    }),
  );

  // Public tracking: anyone with the tracking id (e.g. the receiver, who has
  // no account) sees the route and progress, never names, phones or addresses.
  app.get(
    "/public/track/:trackingId",
    publicLimiter,
    asyncRoute(async (req, res) => {
      const trackingId = String(req.params.trackingId).trim().toUpperCase();

      if (!/^PRCL-\d{8}-[0-9A-F]{8}$/.test(trackingId)) {
        return res.status(400).json({
          success: false,
          message: "That doesn't look like a tracking ID. It looks like PRCL-20261007-1A2B3C4D.",
        });
      }

      const parcel = await collections.parcels.findOne(
        { trackingId },
        {
          projection: {
            trackingId: 1,
            parcelType: 1,
            senderDistrict: 1,
            receiverDistrict: 1,
            deliveryStatus: 1,
            createdAt: 1,
            deliveredAt: 1,
          },
        },
      );

      if (!parcel) {
        return res.status(404).json({ success: false, message: "No parcel found with this tracking ID" });
      }

      const history = await collections.trackings
        .find({ trackingId }, { projection: { status: 1, createdAt: 1 } })
        .sort({ createdAt: 1 })
        .toArray();

      res.json({
        success: true,
        parcel: {
          trackingId: parcel.trackingId,
          parcelType: parcel.parcelType,
          from: parcel.senderDistrict,
          to: parcel.receiverDistrict,
          deliveryStatus: parcel.deliveryStatus,
          bookedAt: parcel.createdAt,
          deliveredAt: parcel.deliveredAt || null,
        },
        // Status only: the messages can contain rider names
        history: history.map((item) => ({ status: item.status, at: item.createdAt })),
      });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                               Contact messages                             */
/* -------------------------------------------------------------------------- */

const CONTACT_TOPICS = ["general", "parcel", "payment", "rider", "business"];

function registerContactRoutes() {
  // Contact page form. Works without login.
  app.post(
    "/contact",
    contactLimiter,
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const name = cleanText(body.name, 80);
      const email = normalizeEmail(body.email);
      const phone = cleanText(body.phone, 20);
      const message = cleanText(body.message, 2000);
      const topic = CONTACT_TOPICS.includes(body.topic) ? body.topic : "general";
      const trackingId = cleanText(body.trackingId, 40).toUpperCase();

      if (!name) {
        return res.status(400).json({ success: false, message: "Please tell us your name" });
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ success: false, message: "Enter a valid email so we can reply" });
      }
      if (phone && !isValidPhone(phone)) {
        return res.status(400).json({ success: false, message: "Enter a valid phone number" });
      }
      if (message.length < 10) {
        return res.status(400).json({ success: false, message: "Please write a little more (at least 10 characters)" });
      }

      const doc = {
        name,
        email,
        phone,
        topic,
        trackingId,
        message,
        status: "new",
        createdAt: new Date(),
      };
      const result = await collections.contactMessages.insertOne(doc);

      res.status(201).json({
        success: true,
        id: result.insertedId,
        message: "Thanks! We got your message and will reply within one business day.",
      });
    }),
  );

  // Admin inbox
  app.get(
    "/admin/messages",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const filter = {};
      if (["new", "resolved"].includes(req.query.status)) {
        filter.status = req.query.status;
      }

      const [messages, newCount] = await Promise.all([
        collections.contactMessages.find(filter).sort({ createdAt: -1 }).limit(200).toArray(),
        collections.contactMessages.countDocuments({ status: "new" }),
      ]);

      res.json({ success: true, count: messages.length, newCount, data: messages });
    }),
  );

  app.patch(
    "/admin/messages/:id",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const { id } = req.params;
      const { status } = req.body ?? {};

      if (!validateObjectId(id)) {
        return res.status(400).json({ success: false, message: "Invalid message id" });
      }
      if (!["new", "resolved"].includes(status)) {
        return res.status(400).json({ success: false, message: "Status must be 'new' or 'resolved'" });
      }

      const result = await collections.contactMessages.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status,
            ...(status === "resolved"
              ? { resolvedAt: new Date(), resolvedBy: req.user.email }
              : {}),
          },
          ...(status === "new" ? { $unset: { resolvedAt: "", resolvedBy: "" } } : {}),
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "Message not found" });
      }
      res.json({ success: true, status });
    }),
  );
}

function registerPaymentRoutes() {
  // Your own payments. Admins can ask for every payment with ?all=1
  app.get(
    "/payments",
    verifyUser,
    asyncRoute(async (req, res) => {
      const filter = {};
      const allPayments = req.query.all === "1" && hasRole(req.user, ROLES.ADMIN);

      if (!allPayments) {
        filter.customerEmail = req.user.email;
      } else if (req.query.email) {
        filter.customerEmail = normalizeEmail(req.query.email);
      }

      const payments = await collections.payments
        .find(filter)
        .sort({ paidAt: -1 })
        .toArray();

      res.json({ success: true, count: payments.length, data: payments });
    }),
  );

  // Marks the parcel paid and saves the payment for a paid Stripe session.
  // Safe to call any number of times for the same session.
  async function recordPaidSession(session, parcel, email) {
    const trackingId = parcel.trackingId || generateTrackingId();
    const transactionId = session.payment_intent;

    // Only the first call flips the parcel to paid
    const parcelUpdate = await collections.parcels.updateOne(
      { _id: parcel._id, paymentStatus: { $ne: "paid" } },
      {
        $set: {
          paymentStatus: "paid",
          trackingId,
          transactionId,
          paidAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    const finalTrackingId =
      parcelUpdate.modifiedCount === 1
        ? trackingId
        : (await collections.parcels.findOne({ _id: parcel._id })).trackingId;

    if (parcelUpdate.modifiedCount === 1) {
      await logTracking(
        { ...parcel, trackingId: finalTrackingId },
        "paid",
        "Payment received",
        email,
      );
    }

    let payment = await collections.payments.findOne({ transactionId });

    if (!payment) {
      // `amount` is always taka (the parcel cost); amountUsd is what Stripe charged
      payment = {
        amount: Number(session.metadata?.amountBdt) || Number(parcel.cost) || 0,
        currency: "bdt",
        amountUsd: (session.amount_total || 0) / 100,
        chargedCurrency: session.currency,
        exchangeRate: Number(session.metadata?.bdtPerUsd) || BDT_PER_USD,
        customerEmail: email,
        parcelId: parcel._id.toString(),
        parcelName: session.metadata?.parcelName || parcel.parcelName || "",
        transactionId,
        paymentStatus: session.payment_status,
        trackingId: finalTrackingId,
        paidAt: new Date(),
      };

      try {
        const insertResult = await collections.payments.insertOne(payment);
        payment._id = insertResult.insertedId;
      } catch (error) {
        // A parallel request already saved this payment (unique index)
        if (error.code !== 11000) throw error;
        payment = await collections.payments.findOne({ transactionId });
      }
    }

    return { trackingId: finalTrackingId, transactionId, payment };
  }

  // The checkout the customer opened last time, if Stripe still knows it
  async function retrieveLastSession(stripeClient, parcel) {
    if (!parcel.checkoutSessionId) return null;
    try {
      return await stripeClient.checkout.sessions.retrieve(parcel.checkoutSessionId);
    } catch (error) {
      console.warn("[PAYMENT] Could not load the previous checkout:", error.message);
      return null;
    }
  }

  app.post(
    "/create-checkout-session",
    verifyUser,
    asyncRoute(async (req, res) => {
      const stripeClient = requireStripeConfigured();
      const parcel = await findParcelOr404(req.body?.parcelId, res);
      if (!parcel) return;

      if (parcel.senderEmail !== req.user.email) {
        return res.status(403).json({ success: false, message: "You can only pay for your own parcels" });
      }
      if (parcel.paymentStatus === "paid") {
        return res.json({ success: true, alreadyPaid: true, trackingId: parcel.trackingId });
      }

      const amount = Number(parcel.cost);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid parcel cost" });
      }

      const publicDomain = requirePublicDomain();
      const parcelId = parcel._id.toString();
      // The cost is in taka: convert to US cents before charging in USD
      const usdCents = bdtToUsdCents(amount);

      // Never charge twice: the customer may have paid last time and closed
      // the tab before coming back, or may still have that checkout open.
      const lastSession = await retrieveLastSession(stripeClient, parcel);
      if (lastSession?.payment_status === "paid") {
        const paid = await recordPaidSession(lastSession, parcel, req.user.email);
        return res.json({ success: true, alreadyPaid: true, trackingId: paid.trackingId });
      }
      if (lastSession?.status === "open" && lastSession.amount_total === usdCents && lastSession.url) {
        return res.json({
          url: lastSession.url,
          sessionId: lastSession.id,
          parcelId,
          amountBdt: amount,
          amountUsd: usdCents / 100,
        });
      }

      const session = await stripeClient.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: usdCents,
              product_data: {
                name: parcel.parcelName || "Parcel delivery",
                description: `Delivery charge ৳${amount} (1 USD = ${BDT_PER_USD} BDT)`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: req.user.email,
        mode: "payment",
        metadata: {
          parcelId,
          parcelName: parcel.parcelName || "",
          senderEmail: req.user.email,
          amountBdt: String(amount),
          bdtPerUsd: String(BDT_PER_USD),
        },
        success_url: `${publicDomain}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicDomain}/dashboard/payment-cancelled?parcel=${parcelId}`,
      });

      await collections.parcels.updateOne(
        { _id: parcel._id },
        { $set: { checkoutSessionId: session.id } },
      );

      res.json({
        url: session.url,
        sessionId: session.id,
        parcelId,
        amountBdt: amount,
        amountUsd: usdCents / 100,
      });
    }),
  );

  // Called by the client after Stripe redirects back. Safe to call more than
  // once (React StrictMode runs effects twice in development).
  const handlePaymentSuccess = asyncRoute(async (req, res) => {
    const stripeClient = requireStripeConfigured();
    const sessionId = req.query.session_id ?? req.query.sessionId;

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ success: false, message: "Missing session_id" });
    }

    const session = await stripeClient.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(409).json({ success: false, message: "Payment not completed" });
    }
    if (normalizeEmail(session.metadata?.senderEmail) !== req.user.email) {
      return res.status(403).json({ success: false, message: "This payment belongs to another user" });
    }

    const parcel = await findParcelOr404(session.metadata?.parcelId, res);
    if (!parcel) return;

    const paid = await recordPaidSession(session, parcel, req.user.email);

    res.json({
      success: true,
      trackingId: paid.trackingId,
      transactionId: paid.transactionId,
      paymentInfo: paid.payment,
      parcel: {
        _id: parcel._id,
        parcelName: parcel.parcelName,
        cost: parcel.cost,
        senderDistrict: parcel.senderDistrict,
        receiverDistrict: parcel.receiverDistrict,
        deliveryCode: parcel.deliveryCode,
      },
    });
  });

  app.get("/payment-success", verifyUser, handlePaymentSuccess);
  app.patch("/payment-success", verifyUser, handlePaymentSuccess);
}

function registerStatsRoutes() {
  const countByStatus = async (match) => {
    const rows = await collections.parcels
      .aggregate([
        { $match: match },
        { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } },
      ])
      .toArray();

    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  };

  // User dashboard: parcel counts by status
  app.get(
    "/stats/user",
    verifyUser,
    asyncRoute(async (req, res) => {
      const byStatus = await countByStatus({ senderEmail: req.user.email });
      res.json({ success: true, byStatus });
    }),
  );

  app.get(
    "/stats/admin",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const [byStatus, roleRows, earningRows, pendingRiders] = await Promise.all([
        countByStatus({}),
        collections.users
          .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
          .toArray(),
        collections.payments
          .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
          .toArray(),
        collections.riders.countDocuments({ status: "pending" }),
      ]);

      const byRole = Object.fromEntries(roleRows.map((row) => [row._id, row.count]));
      const byDistrict = await collections.parcels
        .aggregate([
          { $group: { _id: "$senderDistrict", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ])
        .toArray();

      res.json({
        success: true,
        byStatus,
        byRole,
        totalEarning: earningRows[0]?.total || 0,
        pendingRiders,
        byDistrict: byDistrict.map((row) => ({ district: row._id, count: row.count })),
      });
    }),
  );

  app.get(
    "/stats/rider",
    verifyUser,
    verifyRider,
    asyncRoute(async (req, res) => {
      const email = req.user.email;
      const [toPickup, toDeliver, delivered, rider, requests] = await Promise.all([
        collections.parcels.countDocuments({
          "pickupRider.email": email,
          deliveryStatus: PARCEL_STATUS.READY_TO_PICKUP,
        }),
        collections.parcels.countDocuments({
          "deliveryRider.email": email,
          deliveryStatus: PARCEL_STATUS.READY_FOR_DELIVERY,
        }),
        collections.parcels.countDocuments({
          "deliveryRider.email": email,
          deliveryStatus: PARCEL_STATUS.DELIVERED,
        }),
        collections.riders.findOne({ email }),
        collections.parcels.countDocuments({
          "riderRequest.status": "open",
          "riderRequest.riders.email": email,
          "riderRequest.declinedBy": { $ne: email },
          deliveryStatus: { $in: [PARCEL_STATUS.PENDING, PARCEL_STATUS.SHIPPED] },
        }),
      ]);

      res.json({
        success: true,
        requests,
        toPickup,
        toDeliver,
        delivered,
        earnings: rider?.earnings || 0,
      });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                              Admin dashboard                               */
/* -------------------------------------------------------------------------- */

const ACTIVE_STATUSES = [
  PARCEL_STATUS.PENDING,
  PARCEL_STATUS.READY_TO_PICKUP,
  PARCEL_STATUS.IN_TRANSIT,
  PARCEL_STATUS.REACHED_SERVICE_CENTER,
  PARCEL_STATUS.SHIPPED,
  PARCEL_STATUS.READY_FOR_DELIVERY,
];
// A parcel that has not moved for this long shows up as a shipment alert
const DELAYED_AFTER_HOURS = 48;

function parseRange(value, allowAll = false) {
  const ranges = allowAll ? ["week", "month", "year", "all"] : ["week", "month", "year"];
  if (ranges.includes(value)) return value;
  return allowAll ? "all" : "week";
}

function rangeStart(range) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  if (range === "week") {
    start.setDate(start.getDate() - 6);
  } else if (range === "month") {
    start.setDate(start.getDate() - 29);
  } else if (range === "year") {
    start.setDate(1);
    start.setMonth(start.getMonth() - 11);
  } else {
    return null;
  }

  return start;
}

// Chart buckets: 7 days, 30 days or 12 months ending today
function buildBuckets(range) {
  const start = rangeStart(range);
  const buckets = [];

  if (range === "year") {
    for (let i = 0; i < 12; i++) {
      const from = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const to = new Date(start.getFullYear(), start.getMonth() + i + 1, 1);
      buckets.push({
        from,
        to,
        label: from.toLocaleString("en-US", { month: "short" }),
        fullLabel: from.toLocaleString("en-US", { month: "long", year: "numeric" }),
      });
    }
    return buckets;
  }

  const days = range === "month" ? 30 : 7;
  for (let i = 0; i < days; i++) {
    const from = new Date(start);
    from.setDate(start.getDate() + i);
    const to = new Date(from);
    to.setDate(from.getDate() + 1);
    buckets.push({
      from,
      to,
      label:
        days === 7
          ? from.toLocaleString("en-US", { weekday: "short" })
          : from.toLocaleString("en-US", { day: "numeric", month: "short" }),
      fullLabel: from.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    });
  }
  return buckets;
}

function delayedFilter() {
  const cutoff = new Date(Date.now() - DELAYED_AFTER_HOURS * 60 * 60 * 1000);
  return {
    deliveryStatus: { $in: ACTIVE_STATUSES },
    $or: [
      { updatedAt: { $lt: cutoff } },
      { updatedAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
  };
}

// Waiting for a rider, but no rider will get it without the admin:
// nobody in the district, everyone declined, or no request was ever sent
function needsRiderFilter() {
  return {
    deliveryStatus: { $in: [PARCEL_STATUS.PENDING, PARCEL_STATUS.SHIPPED] },
    $or: [
      { riderRequest: { $exists: false } },
      { "riderRequest.status": { $in: ["no-riders", "declined"] } },
    ],
  };
}

function registerAdminDashboardRoutes() {
  // Everything the admin dashboard overview needs, from MongoDB
  app.get(
    "/admin/overview",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const range = parseRange(req.query.range);
      const buckets = buildBuckets(range);
      const from = buckets[0].from;

      const [
        statusRows,
        payments,
        parcelsInRange,
        lateInvoices,
        pendingRiders,
        pendingRiderCount,
        delayedParcels,
        delayedCount,
        roleRows,
        toPayCount,
        needsRiderParcels,
        needsRiderCount,
        openRequestCount,
        adminRequests,
        newMessages,
        newMessageCount,
      ] = await Promise.all([
        collections.parcels
          .aggregate([{ $group: { _id: "$deliveryStatus", count: { $sum: 1 } } }])
          .toArray(),
        collections.payments
          .find({ paidAt: { $gte: from } }, { projection: { amount: 1, paidAt: 1 } })
          .toArray(),
        collections.parcels
          .find({ createdAt: { $gte: from } }, { projection: { createdAt: 1 } })
          .toArray(),
        collections.parcels
          .find(
            { paymentStatus: { $ne: "paid" } },
            { projection: { parcelName: 1, cost: 1, createdAt: 1, senderName: 1, senderEmail: 1 } },
          )
          .sort({ createdAt: 1 })
          .limit(6)
          .toArray(),
        collections.riders
          .find({ status: "pending" }, { projection: { name: 1, district: 1, appliedAt: 1 } })
          .sort({ appliedAt: -1 })
          .limit(5)
          .toArray(),
        collections.riders.countDocuments({ status: "pending" }),
        collections.parcels
          .find(delayedFilter(), {
            projection: { trackingId: 1, parcelName: 1, deliveryStatus: 1, updatedAt: 1, createdAt: 1 },
          })
          .sort({ updatedAt: 1 })
          .limit(5)
          .toArray(),
        collections.parcels.countDocuments(delayedFilter()),
        collections.users
          .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
          .toArray(),
        collections.parcels.countDocuments({ paymentStatus: { $ne: "paid" } }),
        collections.parcels
          .find(needsRiderFilter(), {
            projection: { trackingId: 1, parcelName: 1, deliveryStatus: 1, riderRequest: 1, updatedAt: 1, createdAt: 1 },
          })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray(),
        collections.parcels.countDocuments(needsRiderFilter()),
        collections.parcels.countDocuments({
          deliveryStatus: { $in: [PARCEL_STATUS.PENDING, PARCEL_STATUS.SHIPPED] },
          "riderRequest.status": "open",
        }),
        collections.adminRequests
          .find({ status: "pending" }, { projection: { name: 1, email: 1, requestedAt: 1 } })
          .sort({ requestedAt: -1 })
          .toArray(),
        collections.contactMessages
          .find({ status: "new" }, { projection: { name: 1, topic: 1, createdAt: 1 } })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray(),
        collections.contactMessages.countDocuments({ status: "new" }),
      ]);

      const byStatus = Object.fromEntries(statusRows.map((row) => [row._id, row.count]));
      const count = (...keys) => keys.reduce((sum, key) => sum + (byStatus[key] || 0), 0);

      const series = buckets.map((bucket) => {
        const inBucket = (date) => date >= bucket.from && date < bucket.to;
        const bucketPayments = payments.filter((payment) => inBucket(new Date(payment.paidAt)));
        return {
          label: bucket.label,
          fullLabel: bucket.fullLabel,
          revenue: bucketPayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0),
          payments: bucketPayments.length,
          parcels: parcelsInRange.filter((parcel) => inBucket(new Date(parcel.createdAt))).length,
        };
      });

      const alerts = [
        ...needsRiderParcels.map((parcel) => ({
          type: "no-rider",
          title:
            parcel.riderRequest?.status === "declined"
              ? "All riders declined"
              : parcel.riderRequest
                ? "No rider in this area"
                : "Rider request not sent",
          subtitle: `${parcel.trackingId || parcel.parcelName} · ${parcel.riderRequest?.district || "assign manually"}`,
          at: parcel.riderRequest?.respondedAt || parcel.riderRequest?.createdAt || parcel.createdAt,
          link: `/dashboard/manage-parcel/${parcel._id}`,
        })),
        ...adminRequests.slice(0, 3).map((request) => ({
          type: "admin-request",
          title: "Admin access request",
          subtitle: `${request.name} · ${request.email}`,
          at: request.requestedAt,
          link: "/dashboard/admin-requests",
        })),
        ...newMessages.map((message) => ({
          type: "message",
          title: "New contact message",
          subtitle: `${message.name} · ${message.topic}`,
          at: message.createdAt,
          link: "/dashboard/messages",
        })),
        ...pendingRiders.map((rider) => ({
          type: "rider",
          title: "Rider application",
          subtitle: `${rider.name} · ${rider.district}`,
          at: rider.appliedAt,
          link: "/dashboard/manage-riders",
        })),
        ...delayedParcels.map((parcel) => ({
          type: "delayed",
          title: "Delayed shipment",
          subtitle: parcel.trackingId || parcel.parcelName,
          status: parcel.deliveryStatus,
          at: parcel.updatedAt || parcel.createdAt,
          link: `/dashboard/manage-parcel/${parcel._id}`,
        })),
      ]
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 8);

      res.json({
        success: true,
        range,
        cards: {
          toPay: toPayCount,
          readyPickup: count(PARCEL_STATUS.PENDING, PARCEL_STATUS.READY_TO_PICKUP),
          inTransit: count(
            PARCEL_STATUS.IN_TRANSIT,
            PARCEL_STATUS.REACHED_SERVICE_CENTER,
            PARCEL_STATUS.SHIPPED,
          ),
          readyToDeliver: count(PARCEL_STATUS.READY_FOR_DELIVERY),
          delivered: count(PARCEL_STATUS.DELIVERED),
        },
        totals: {
          revenue: series.reduce((sum, point) => sum + point.revenue, 0),
          payments: payments.length,
          parcels: parcelsInRange.length,
          customers: roleRows.find((row) => row._id === ROLES.USER)?.count || 0,
          riders: roleRows.find((row) => row._id === ROLES.RIDER)?.count || 0,
        },
        series,
        lateInvoices,
        alertCounts: {
          pendingRiders: pendingRiderCount,
          delayed: delayedCount,
          needsRider: needsRiderCount,
          pendingAdminRequests: adminRequests.length,
          waitingForRiders: openRequestCount,
          newMessages: newMessageCount,
        },
        alerts,
      });
    }),
  );

  // Paginated shipping report table
  app.get(
    "/admin/shipments",
    verifyUser,
    verifyAdmin,
    asyncRoute(async (req, res) => {
      const range = parseRange(req.query.range, true);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));
      const page = Math.max(1, Number(req.query.page) || 1);
      const filter = {};
      const from = rangeStart(range);

      if (from) filter.createdAt = { $gte: from };
      if (Object.values(PARCEL_STATUS).includes(req.query.status)) {
        filter.deliveryStatus = req.query.status;
      }
      if (req.query.search) {
        const pattern = { $regex: escapeRegex(req.query.search.trim()), $options: "i" };
        filter.$or = [{ trackingId: pattern }, { senderName: pattern }, { parcelName: pattern }];
      }

      const [total, data] = await Promise.all([
        collections.parcels.countDocuments(filter),
        collections.parcels
          .find(filter, {
            projection: {
              trackingId: 1,
              parcelName: 1,
              parcelType: 1,
              parcelWeight: 1,
              senderName: 1,
              senderEmail: 1,
              senderDistrict: 1,
              receiverDistrict: 1,
              pickupRider: 1,
              deliveryRider: 1,
              cost: 1,
              paymentStatus: 1,
              deliveryStatus: 1,
              createdAt: 1,
            },
          })
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);

      res.json({
        success: true,
        data,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Startup                                   */
/* -------------------------------------------------------------------------- */

// Older parcels used "unpaid"/"paid" as delivery statuses and only got a
// tracking id after payment. Bring them to the current model.
async function migrateParcels() {
  await collections.parcels.updateMany(
    {
      $or: [
        { deliveryStatus: { $in: ["unpaid", "paid"] } },
        { deliveryStatus: { $exists: false } },
      ],
    },
    { $set: { deliveryStatus: PARCEL_STATUS.PENDING } },
  );

  const withoutTracking = await collections.parcels
    .find({ trackingId: { $exists: false } }, { projection: { _id: 1 } })
    .toArray();
  for (const parcel of withoutTracking) {
    await collections.parcels.updateOne(
      { _id: parcel._id },
      { $set: { trackingId: generateTrackingId() } },
    );
  }

  // Parcels still on their way get a delivery code too
  const withoutCode = await collections.parcels
    .find(
      { deliveryCode: { $exists: false }, deliveryStatus: { $ne: PARCEL_STATUS.DELIVERED } },
      { projection: { _id: 1 } },
    )
    .toArray();
  for (const parcel of withoutCode) {
    await collections.parcels.updateOne(
      { _id: parcel._id },
      { $set: { deliveryCode: generateDeliveryCode() } },
    );
  }
}

// Profiles created before riderStatus existed get it from their application
async function syncRiderStatus() {
  const applications = await collections.riders
    .find({}, { projection: { email: 1, status: 1 } })
    .toArray();

  for (const application of applications) {
    await collections.users.updateOne(
      { email: application.email, riderStatus: { $exists: false } },
      { $set: { riderStatus: application.status } },
    );
  }

  await collections.users.updateMany(
    { riderStatus: { $exists: false } },
    { $set: { riderStatus: "none" } },
  );
}

function registerNotFoundHandler() {
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
      path: req.path,
      method: req.method,
    });
  });
}

function registerErrorHandler() {
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error("[ERROR]", req.method, req.path, error.message);

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "An unexpected error occurred on the server",
    });
  });
}

async function createIndexes() {
  const indexes = [
    [collections.users, { email: 1 }, { unique: true }],
    [collections.riders, { email: 1 }, { unique: true }],
    [collections.payments, { transactionId: 1 }, { unique: true, sparse: true }],
    [collections.parcels, { senderEmail: 1, createdAt: -1 }, {}],
    [collections.parcels, { trackingId: 1 }, {}],
    [collections.parcels, { "riderRequest.status": 1, "riderRequest.riders.email": 1 }, {}],
    [collections.trackings, { trackingId: 1, createdAt: 1 }, {}],
    [collections.adminRequests, { email: 1 }, { unique: true }],
    [collections.partTimeRiders, { phone: 1 }, { unique: true }],
    [collections.adminRequests, { status: 1, requestedAt: -1 }, {}],
    [collections.contactMessages, { status: 1, createdAt: -1 }, {}],
  ];

  for (const [collection, keys, options] of indexes) {
    try {
      await collection.createIndex(keys, options);
    } catch (error) {
      console.warn(
        `[DB] Could not create index on ${collection.collectionName}:`,
        error.message,
      );
    }
  }
}

// Connect once per server instance (on Vercel: once per cold start) and
// prepare indexes / older data. Requests wait for this before running.
let databaseReady = null;

function connectDatabase() {
  if (!databaseReady) {
    databaseReady = (async () => {
      const client = new MongoClient(buildMongoUri(), {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      });

      await client.connect();

      const db = client.db("zap_shift_DB");
      collections.users = db.collection("users");
      collections.riders = db.collection("riders");
      collections.parcels = db.collection("parcels");
      collections.payments = db.collection("payments");
      collections.trackings = db.collection("trackings");
      collections.adminRequests = db.collection("admin_requests");
      collections.system = db.collection("system");
      collections.partTimeRiders = db.collection("part_time_riders");
      collections.contactMessages = db.collection("contact_messages");

      await db.command({ ping: 1 });
      await createIndexes();
      await migrateParcels();
      await syncRiderStatus();
    })().catch((error) => {
      // Try again on the next request instead of staying broken
      databaseReady = null;
      throw error;
    });
  }
  return databaseReady;
}

registerBaseMiddleware();
registerHealthRoutes();

// Every route below needs the database
app.use(
  asyncRoute(async (req, res, next) => {
    await connectDatabase();
    next();
  }),
);

registerAuthRoutes();
registerUserRoutes();
registerRiderRoutes();
registerParcelRoutes();
registerRiderTaskRoutes();
registerTrackingRoutes();
registerPaymentRoutes();
registerStatsRoutes();
registerAdminDashboardRoutes();
registerAdminRequestRoutes();
registerContactRoutes();
registerNotFoundHandler();
registerErrorHandler();

// `npm start` / `npm run dev` on your computer. On Vercel the exported app
// is used instead (it becomes one serverless function).
if (require.main === module) {
  connectDatabase()
    .then(() => {
      app.listen(port, () => {
        console.log(`Zap Shift server listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to start server:", error);
      process.exit(1);
    });
}

module.exports = app;
