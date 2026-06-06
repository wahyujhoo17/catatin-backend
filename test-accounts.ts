import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const users = await prisma.user.findMany()
  for (const u of users) {
    const accs = await prisma.account.findMany({ where: { userId: u.id } })
    console.log(u.email, accs.map(a => `${a.name}: ${a.balance}`))
  }
}
main().then(() => prisma.$disconnect())
