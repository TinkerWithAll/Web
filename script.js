// PROFESSIONAL BACKGROUND
const jobs = [
  {
    title: "Cybersecurity Specialist - Vulnerability Management",
    years: "2023 – Present",
    summary: "Overseeing assessments of security posture through vulnerability scanning & penetration testing.",
    description: "Responsible for managing vulnerability scanning, penetration testing, and ensuring effective communication and remediation of findings across teams."
  },
  {
    title: "IT Security Analyst",
    years: "2021 – 2023",
    summary: "Supported endpoint protection and identity management across enterprise systems.",
    description: "Implemented endpoint security tools, monitored SIEM alerts, and supported identity access management processes while working closely with senior engineers."
  },
  {
    title: "Technical Support Specialist",
    years: "2018 – 2021",
    summary: "Provided frontline IT support while developing a passion for security.",
    description: "Resolved end-user technical issues, assisted in patch management processes, and initiated security awareness activities within the IT team."
  }
];

const backgroundContainer = document.getElementById("background-container");

jobs.forEach(job => {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <h3>${job.title} <span>(${job.years})</span></h3>
    <p><strong>${job.summary}</strong></p>
    <p class="full">${job.description}</p>
  `;
  div.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });
  backgroundContainer.appendChild(div);
});

// BLOG POSTS
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
  div.className = "card";
  div.innerHTML = `
    <img src="${post.image}" alt="${post.title}" style="max-width:100%; border-radius:5px;"/>
    <h3>${post.title}</h3>
    <small>${post.date}</small>
    <p><strong>${post.desc}</strong></p>
    <p class="full">${post.content}</p>
  `;
  div.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });
  blogContainer.appendChild(div);
});
