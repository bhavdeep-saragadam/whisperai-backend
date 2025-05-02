import express from 'express'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import cors from 'cors'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET'
]

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar])
if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars.join(', '))
  process.exit(1)
}

const app = express()
const port = process.env.PORT || 3000

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'development' 
    ? ['http://localhost:8080', 'http://localhost:3000', 'http://localhost:5173'] 
    : ['https://whisperai-lemon.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature', 'Accept']
}))

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`)
  console.log('Headers:', req.headers)
  console.log('Origin:', req.headers.origin)
  next()
})

// Parse JSON bodies for all routes except webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    next()
  } else {
    express.json()(req, res, next)
  }
})

// Initialize Stripe with test mode
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
  typescript: true,
})

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'WhisperAI Backend API is running',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'WhisperAI Backend API is healthy',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      supabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  })
})

// Create or verify customer endpoint
app.post('/api/verify-customer', async (req, res) => {
  try {
    const { userId, email } = req.body
    if (!userId || !email) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Check if user already has a Stripe customer ID
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single()

    let customerId = user?.stripe_customer_id

    if (customerId) {
      try {
        // Verify customer exists in Stripe
        const customer = await stripe.customers.retrieve(customerId)
        if (customer.deleted) {
          customerId = null
        }
      } catch (error) {
        console.error('Error retrieving customer:', error)
        customerId = null
      }
    }

    if (!customerId) {
      // Create new customer in Stripe
      const customer = await stripe.customers.create({
        email,
        metadata: {
          userId,
        },
      })
      customerId = customer.id

      // Store customer ID in Supabase
      const { error: updateError } = await supabase
        .from('users')
        .upsert({
          id: userId,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })

      if (updateError) {
        console.error('Error updating user:', updateError)
      }
    }

    res.json({ customerId })
  } catch (error) {
    console.error('Error in verify-customer:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create checkout session endpoint
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { priceId, customerId, testMode } = req.body
    if (!priceId || !customerId) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    console.log('Creating checkout session:', {
      priceId,
      customerId,
      testMode
    })

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/profile?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: {
        testMode: testMode ? 'true' : 'false',
        userId: req.body.userId // Add userId to metadata
      },
    })

    console.log('Checkout session created:', {
      sessionId: session.id,
      url: session.url
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error('Error creating checkout session:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Test webhook endpoint
app.post('/api/webhook-test', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('Test webhook received')
  console.log('Headers:', req.headers)
  console.log('Body:', req.body)
  res.json({ received: true })
})

// Stripe webhook endpoint
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    console.log('Webhook received with signature:', sig)
    console.log('Webhook headers:', req.headers)
    
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
    console.log('Received webhook event:', event.type)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object
        const customerId = subscription.customer
        console.log('Processing subscription:', {
          type: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId,
          metadata: subscription.metadata
        })

        // Get user ID from customer metadata
        const customer = await stripe.customers.retrieve(customerId)
        const userId = customer.metadata.userId

        if (!userId) {
          console.error('No user ID found in customer metadata')
          return res.status(400).json({ error: 'No user ID found' })
        }

        console.log('Found user ID:', userId)

        // Update subscription in Supabase
        const { data: subscriptionData, error: upsertError } = await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscription.id,
            status: subscription.status,
            price_id: subscription.items.data[0].price.id,
            quantity: subscription.items.data[0].quantity,
            cancel_at_period_end: subscription.cancel_at_period_end,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            ended_at: subscription.ended_at ? new Date(subscription.ended_at * 1000).toISOString() : null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_subscription_id'
          })

        if (upsertError) {
          console.error('Error upserting subscription:', upsertError)
          return res.status(500).json({ error: 'Database error' })
        }

        console.log('Successfully updated subscription:', subscriptionData)
        break

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object
        const deletedCustomerId = deletedSubscription.customer
        console.log('Processing deleted subscription:', {
          subscriptionId: deletedSubscription.id,
          customerId: deletedCustomerId
        })

        // Get user ID from customer metadata
        const deletedCustomer = await stripe.customers.retrieve(deletedCustomerId)
        const deletedUserId = deletedCustomer.metadata.userId

        if (!deletedUserId) {
          console.error('No user ID found in customer metadata')
          return res.status(400).json({ error: 'No user ID found' })
        }

        console.log('Found user ID for deleted subscription:', deletedUserId)

        // Update subscription status in Supabase
        const { data: updateData, error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            ended_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', deletedUserId)
          .eq('stripe_subscription_id', deletedSubscription.id)

        if (updateError) {
          console.error('Error updating subscription:', updateError)
          return res.status(500).json({ error: 'Database error' })
        }

        console.log('Successfully updated deleted subscription:', updateData)
        break
    }

    res.json({ received: true })
  } catch (error) {
    console.error('Error processing webhook:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Auth callback endpoint
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query
    
    if (!code) {
      return res.status(400).json({ error: 'No code provided' })
    }

    // Exchange the code for a session
    const { data: { session }, error } = await supabase.auth.exchangeCodeForSession(code)
    
    if (error) {
      console.error('Error exchanging code for session:', error)
      return res.status(400).json({ error: error.message })
    }

    // Redirect to the frontend with the session
    res.redirect(`${req.headers.origin}/auth/callback?session=${encodeURIComponent(JSON.stringify(session))}`)
  } catch (error) {
    console.error('Error in auth callback:', error)
    res.status(500).json({ error: error.message || 'Error processing auth callback' })
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something broke!' })
})

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`Test Mode: ${process.env.NODE_ENV === 'development' || process.env.TEST_MODE === 'true' ? 'enabled' : 'disabled'}`)
}) 