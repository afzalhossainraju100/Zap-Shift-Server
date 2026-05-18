const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();

const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY,
);

const port = process.env.PORT || 3000;

//middle wares
app.use(cors());
app.use(express.json());

//mongodb connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.1ezipje.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});



async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("zap_shift_DB");
    const parcelCollection = db.collection("parcels");
    //api to get all parcels
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      const options = {
        sort: { createdAt: -1 },
      };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      //parcel create time
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.findOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.patch("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

        const updateParcel = req.body;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updateParcel,
        };
        const result = await parcelCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    //stripe payment intent api
    app.post('/create-checkout-session', async (req, res) =>{
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.amount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.PAY_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.PAY_DOMAIN}/dashboard/payment-cancelled`,
      });
      console.log(session);
      res.send({ url: session.url });
      // res.redirect(303, session.url);
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap Is Shifting To The Cloud!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
