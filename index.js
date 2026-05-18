import mysql from 'mysql2/promise';
import {
  DynamoDBClient,
  BatchGetItemCommand,
  UpdateItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand
} from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const pathParams = event.pathParameters || {};
  const queryParams = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // Section 3
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
        "Access-Control-Allow-Credentials": true
      },
      body: ''
    };
  }

  // Section 4
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  try {
    // ========== [1] GET /event/{event_id} ==========
    if (method === "GET" && path.startsWith("/event/")) {
      const eventId = pathParams.event_id;
      console.log('Looking for event ID:', eventId);

      const [rows] = await conn.execute("SELECT * FROM events WHERE event_id = ?", [eventId]);
      if (rows.length === 0) {
        return json({ message: "Event not found" }, 404);
      }
      return json(rows[0]);
    }

    // ========== [2] GET /stats/{event_id} ==========
    if (method === "GET" && path.startsWith("/stats/")) {
      const eventId = pathParams.event_id;
      console.log('Getting stats for:', eventId);

      const responses = ['Yes', 'No'];
      const keys = responses.map(r => ({
        pk: { S: `EVENT#${eventId}` },
        sk: { S: `RESPONSE#${r}` },
      }));

      const result = await dynamo.send(new BatchGetItemCommand({
        RequestItems: { "event-rsvp-counts": { Keys: keys } }
      }));

      const items = result.Responses?.["event-rsvp-counts"] || [];
      const counts = { Yes: 0, No: 0 };
      for (const item of items) {
        const key = item.sk.S.split("#")[1];
        counts[key] = Number(item.count?.N || 0);
      }

      return json(counts);
    }

    // ========== [3] POST /rsvp ==========
    if (method === "POST" && path === "/rsvp") {
      const { event_id, full_name, email, response } = body;
      console.log('RSVP request:', { event_id, full_name, email, response });

      if (!event_id || !full_name || !response || !email) {
        return json({
          message: "Missing fields. Email is required to prevent duplicate RSVPs."
        }, 400);
      }

      const now = Date.now();

      try {
        // 1) Put the attendee record IF it doesn't exist yet
        // 2) Increment the right counter (Yes/No) atomically
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: "event-rsvp-counts",
                Item: {
                  pk:        { S: `EVENT#${event_id}` },
                  sk:        { S: `RESPONDENT#${email}` }, // uniqueness per event+email
                  full_name: { S: full_name },
                  email:     { S: email },
                  response:  { S: response },
                  timestamp: { N: String(now) }
                },
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
              }
            },
            {
              Update: {
                TableName: "event-rsvp-counts",
                Key: {
                  pk: { S: `EVENT#${event_id}` },
                  sk: { S: `RESPONSE#${response}` }
                },
                UpdateExpression: "ADD #count :one",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":one": { N: "1" } }
              }
            }
          ]
        }));

        return json({ message: "RSVP recorded successfully" });

      } catch (err) {
        if (err.name === "TransactionCanceledException" || err.name === "ConditionalCheckFailedException") {
          return json({
            message: "You have already RSVP'd for this event with this email!",
            code: "DUPLICATE_RSVP"
          }, 409);
        }
        console.error('DynamoDB error:', err);
        return json({ error: err.message }, 500);
      }
    }

    // ========== [4] GET /attendees/{event_id} ==========
    if (method === "GET" && path.startsWith("/attendees/")) {
      const eventId = pathParams.event_id;
      const responseType = queryParams.response; // Optional filter

      let keyCondition = "pk = :pk AND begins_with(sk, :prefix)";
      let expressionValues = {
        ":pk": { S: `EVENT#${eventId}` },
        ":prefix": { S: "RESPONDENT#" }
      };

      // Filter by response type if provided
      if (responseType) {
        keyCondition = "pk = :pk AND begins_with(sk, :prefix)";
        expressionValues[":prefix"] = { S: `RESPONDENT#` };
      }

      const result = await dynamo.send(new QueryCommand({
        TableName: "event-rsvp-counts",
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expressionValues,
      }));

      let attendees = result.Items.map(item => ({
        full_name: item.full_name?.S,
        email: item.email?.S,
        response: item.response?.S,
        timestamp: parseInt(item.timestamp?.N)
      }));

      if (responseType) {
        attendees = attendees.filter(a => a.response === responseType);
      }
      return json(attendees);
    }

    // ========== [5] GET /events ==========
    if (method === "GET" && path === "/events") {
      console.log('Fetching all events');
      const [rows] = await conn.execute(`
        SELECT event_id, title, description, start_at, venue, banner_url, created_at
        FROM events
        ORDER BY start_at ASC
      `);
      return json(rows);
    }

    // ========== Fallback ==========
    return json({ message: "Route not found" }, 404);

  } catch (err) {
    console.error('Error:', err);
    return json({ error: err.message }, 500);
  } finally {
    if (conn) await conn.end();
  }
};

// Helper function for consistent JSON responses
function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
      "Access-Control-Allow-Credentials": true
    },
    body: JSON.stringify(data),
  };
}