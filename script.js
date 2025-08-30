// BACKGROUND JOBS
const jobs = [
  {
    title: "Cybersecurity Specialist",
    company: "Canadian Tire",
    years: "2023 – Present",
    shortDesc: "Overseeing vulnerability management and penetration testing.",
    longDesc: "As part of the Vulnerability Management team, I handle scanning, penetration testing coordination, risk assessment, and ensure remediation efforts are communicated effectively to stakeholders across multiple business units."
  },
  {
    title: "IT Support Specialist",
    company: "Tech Solutions Inc.",
    years: "2021 – 2023",
    shortDesc: "Provided IT support to end-users and managed security tools.",
    longDesc: "Worked with endpoint protection tools, handled incident response for small-scale security events, supported Active Directory and M365 administration, and trained employees on cybersecurity best practices."
  },
  {
    title: "Intern – Cybersecurity Analyst",
    company: "XYZ Corp",
    years: "2020 – 2021",
    shortDesc: "Assisted with security monitoring and reporting.",
    longDesc: "Helped monitor SIEM logs, performed initial triage of alerts, documented findings, and supported the senior analysts in developing runbooks for incident handling."
  }
];

const backgroundContainer = document.getElementById("background-container");

jobs.forEach(job => {
  const div = document.createElement("div");
  div.className = "job-card";
  div.innerHTML = `
    <h3>${job.title}</h3>
    <small>${job.company} | ${job.years}</small>
    <p><strong>${job.shortDesc}</strong></p>
    <p class="details">${job.longDesc}</p>
  `;
  div.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });
  backgroundContainer.appendChild(div);
});

const blogPosts = [
  {
    title: "Pi Router",
    date: "2025-08-29",
    desc: "Configure OpenWrt on your Raspbery Pi 5 to add a security layer to your network.",
    content: "Soon i will post a walkthrough of how i configured my own router using openwrt on a pi so that you can secure your network too!",
    image: "https://via.placeholder.com/400x200"
  },
{
  "title": "Process of Getting My Security + Cert",
  "date": "2025-08-15",
  "desc": "A look into my journey of studying for and earning the CompTIA Security+ certification, and how it shaped my cybersecurity career.",
  "content": "Preparing for my Security+ certification was both challenging and rewarding. It gave me a structured way to deepen my understanding of core security concepts, from risk management and network security to identity, access, and cryptography. While I was already working in vulnerability management, studying for this certification pushed me to strengthen my fundamentals and think about security in a broader context. The process involved countless study hours, labs, and practice exams, but ultimately it gave me the confidence to approach my work with a stronger foundation and a mindset of continuous learning."
}
];

const blogContainer = document.getElementById("blog-container");

blogPosts.forEach(post => {
  const div = document.createElement("div");
  div.className = "blog-post";
  div.innerHTML = `
    <img src="${post.image}" alt="${post.title}" style="max-width:100%; border-radius:5px;"/>
    <h3>${post.title}</h3>
    <small>${post.date}</small>
    <p><strong>${post.desc}</strong></p>
    <p>${post.content}</p>
  `;
  div.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });
  blogContainer.appendChild(div);
});
